import path from "node:path";
import {
  CodeAction,
  CodeActionKind,
  type Diagnostic,
  type CodeAction as LspCodeAction,
  type Range,
  type TextEdit,
} from "vscode-languageserver/lib/node/main.js";
import { LineIndex } from "./text.js";
import { toFilePath } from "./files.js";
import type { AutoImportAnalysis } from "./types.js";

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

const offsetAfterLine = ({
  source,
  offset,
}: {
  source: string;
  offset: number;
}): number => {
  let cursor = Math.max(0, Math.min(offset, source.length));
  while (cursor < source.length && source[cursor] !== "\n") {
    cursor += 1;
  }
  return cursor < source.length ? cursor + 1 : source.length;
};

export type ImportInsertionContext = {
  range: Range;
  prefix: string;
};

export const resolveImportInsertionContext = ({
  analysis,
  documentUri,
}: {
  analysis: Pick<AutoImportAnalysis, "moduleIdByFilePath" | "semantics" | "graph">;
  documentUri: string;
}): ImportInsertionContext | undefined => {
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

  const insertionOffset =
    useEndOffsets.length > 0
      ? offsetAfterLine({
          source,
          offset: Math.max(...useEndOffsets),
        })
      : 0;
  const insertionRange = {
    start: lineIndex.positionAt(insertionOffset),
    end: lineIndex.positionAt(insertionOffset),
  };

  const prefix =
    insertionOffset === source.length &&
    insertionOffset > 0 &&
    source[source.length - 1] !== "\n"
      ? "\n"
      : "";

  return {
    range: insertionRange,
    prefix,
  };
};

export const insertImportEditFromContext = ({
  context,
  importLine,
}: {
  context: ImportInsertionContext;
  importLine: string;
}): TextEdit => ({
  range: context.range,
  newText: `${context.prefix}${importLine}\n`,
});

export const insertImportEdit = ({
  analysis,
  documentUri,
  importLine,
}: {
  analysis: Pick<AutoImportAnalysis, "moduleIdByFilePath" | "semantics" | "graph">;
  documentUri: string;
  importLine: string;
}): TextEdit | undefined => {
  const context = resolveImportInsertionContext({
    analysis,
    documentUri,
  });
  if (!context) {
    return undefined;
  }
  return insertImportEditFromContext({
    context,
    importLine,
  });
};

const importActionsForDiagnostic = ({
  analysis,
  documentUri,
  diagnostic,
}: {
  analysis: AutoImportAnalysis;
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
  analysis: AutoImportAnalysis;
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
