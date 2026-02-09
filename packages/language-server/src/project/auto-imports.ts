import path from "node:path";
import {
  CodeAction,
  CodeActionKind,
  type Diagnostic,
  type CodeAction as LspCodeAction,
  type TextEdit,
} from "vscode-languageserver/lib/node/main.js";
import { LineIndex } from "./text.js";
import { toFilePath } from "./files.js";
import type { ProjectAnalysis } from "./types.js";

const extractMissingSymbolName = (diagnostic: Diagnostic): string | undefined => {
  const match = /'([^']+)'/.exec(diagnostic.message);
  return match?.[1];
};

const supportsAutoImport = (code: string): boolean =>
  code === "TY0006" || code === "TY0026" || code === "TY0030";

const kindMatchesDiagnostic = ({ code, kind }: { code: string; kind: string }): boolean => {
  if (code === "TY0026") {
    return kind === "type" || kind === "trait";
  }

  if (code === "TY0006") {
    return kind === "value";
  }

  return kind !== "module";
};

const insertImportEdit = ({
  analysis,
  documentUri,
  importLine,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  importLine: string;
}): TextEdit | undefined => {
  const filePath = path.resolve(toFilePath(documentUri));
  const moduleId = analysis.moduleIdByFilePath.get(filePath);
  if (!moduleId) {
    return undefined;
  }

  const semantics = analysis.semantics.get(moduleId);
  const moduleNode = analysis.graph.modules.get(moduleId);
  const source = moduleNode?.source;
  if (!source) {
    return undefined;
  }

  const lineIndex = new LineIndex(source);
  const useEndOffsets = semantics
    ? semantics.binding.uses
        .map((useDecl) => useDecl.form.location?.endIndex)
        .filter((offset): offset is number => typeof offset === "number")
    : [];

  const insertionOffset = useEndOffsets.length > 0 ? Math.max(...useEndOffsets) : 0;
  const insertionRange = {
    start: lineIndex.positionAt(insertionOffset),
    end: lineIndex.positionAt(insertionOffset),
  };

  const prefix = insertionOffset > 0 ? "\n" : "";
  const suffix = insertionOffset > 0 ? "" : "\n";

  return {
    range: insertionRange,
    newText: `${prefix}${importLine}${suffix}`,
  };
};

const importActionsForDiagnostic = ({
  analysis,
  documentUri,
  diagnostic,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  diagnostic: Diagnostic;
}): LspCodeAction[] => {
  const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
  if (!code || !supportsAutoImport(code)) {
    return [];
  }

  const missingName = extractMissingSymbolName(diagnostic);
  if (!missingName) {
    return [];
  }

  const currentFilePath = path.resolve(toFilePath(documentUri));
  const currentModuleId = analysis.moduleIdByFilePath.get(currentFilePath);

  const candidates = (analysis.exportsByName.get(missingName) ?? [])
    .filter((candidate) => candidate.moduleId !== currentModuleId)
    .filter((candidate) => kindMatchesDiagnostic({ code, kind: candidate.kind }));

  const seenImportLines = new Set<string>();

  return candidates
    .map((candidate) => {
      const importLine = `use ${candidate.moduleId}::${candidate.name}`;
      if (seenImportLines.has(importLine)) {
        return undefined;
      }
      seenImportLines.add(importLine);

      const edit = insertImportEdit({
        analysis,
        documentUri,
        importLine,
      });
      if (!edit) {
        return undefined;
      }

      return CodeAction.create(
        `Import ${candidate.name} from ${candidate.moduleId}`,
        {
          changes: {
            [documentUri]: [edit],
          },
        },
        CodeActionKind.QuickFix,
      );
    })
    .filter((action): action is LspCodeAction => Boolean(action));
};

export const autoImportActions = ({
  analysis,
  documentUri,
  diagnostics,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  diagnostics: readonly Diagnostic[];
}): LspCodeAction[] =>
  diagnostics.flatMap((diagnostic) =>
    importActionsForDiagnostic({
      analysis,
      documentUri,
      diagnostic,
    }),
  );
