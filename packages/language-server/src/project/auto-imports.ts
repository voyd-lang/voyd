import path from "node:path";
import type { Form } from "@voyd/compiler/parser/index.js";
import { parseTopLevelUseDecl } from "@voyd/compiler/modules/use-decl.js";
import {
  parseUsePaths,
  type NormalizedUseEntry,
} from "@voyd/compiler/modules/use-path.js";
import { toSourceSpan } from "@voyd/compiler/semantics/utils.js";
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

const IMPORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_']*$/;

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

const sameSegments = ({
  left,
  right,
}: {
  left: readonly string[] | undefined;
  right: readonly string[] | undefined;
}): boolean => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((segment, index) => segment === right[index]);
};

const importModulePath = ({
  analysis,
  currentModuleId,
  candidateModuleId,
}: {
  analysis: Pick<AutoImportAnalysis, "graph">;
  currentModuleId?: string;
  candidateModuleId: string;
}): string => {
  if (!currentModuleId) {
    return candidateModuleId;
  }

  const currentModule = analysis.graph.modules.get(currentModuleId);
  const candidateModule = analysis.graph.modules.get(candidateModuleId);
  if (!currentModule || !candidateModule) {
    return candidateModuleId;
  }

  const currentNamespace = currentModule.path.namespace;
  if (currentNamespace !== "src" || candidateModule.path.namespace !== "src") {
    return candidateModuleId;
  }
  if (currentModule.path.segments.at(-1) !== "pkg") {
    return candidateModuleId;
  }
  if (
    !sameSegments({
      left: currentModule.sourcePackageRoot,
      right: candidateModule.sourcePackageRoot,
    })
  ) {
    return candidateModuleId;
  }

  const packageRoot = currentModule.sourcePackageRoot ?? [];
  if (candidateModule.path.segments.length <= packageRoot.length) {
    return candidateModuleId;
  }

  const relativeSegments = candidateModule.path.segments.slice(packageRoot.length);
  if (relativeSegments.length === 0 || relativeSegments[0] === "pkg") {
    return candidateModuleId;
  }

  return `self::${relativeSegments.join("::")}`;
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

const lineStartOffsetFor = ({
  source,
  offset,
}: {
  source: string;
  offset: number;
}): number => {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  const previousNewline = source.lastIndexOf("\n", Math.max(0, boundedOffset - 1));
  return previousNewline < 0 ? 0 : previousNewline + 1;
};

const leadingIndentationAt = ({
  source,
  offset,
}: {
  source: string;
  offset: number;
}): string => {
  const lineStart = lineStartOffsetFor({ source, offset });
  const indentation = source.slice(lineStart, offset);
  return /^\s*$/.test(indentation) ? indentation : "";
};

const modulePathTextForUseEntry = (entry: NormalizedUseEntry): string | undefined => {
  if (!entry.hasExplicitPrefix) {
    return undefined;
  }

  const basePath = entry.moduleSegments.join("::");
  if (entry.anchorToSelf) {
    return basePath.length > 0 ? `self::${basePath}` : "self";
  }

  const parentHops = entry.parentHops ?? 0;
  if (parentHops > 0) {
    const superPath = Array.from({ length: parentHops }, () => "super").join("::");
    return basePath.length > 0 ? `${superPath}::${basePath}` : superPath;
  }

  return basePath.length > 0 ? basePath : undefined;
};

const useDeclRewriteContextFromForm = ({
  useForm,
  source,
  startIndex,
}: {
  useForm: Form;
  source: string;
  startIndex: number;
}):
  | {
      indentation: string;
      visibility: "" | "pub ";
      modulePath: string;
    }
  | undefined => {
  const parsedUseDecl = parseTopLevelUseDecl(useForm);
  if (!parsedUseDecl) {
    return undefined;
  }

  const entries = parseUsePaths(parsedUseDecl.pathExpr, toSourceSpan(useForm));
  const first = entries[0];
  if (!first) {
    return undefined;
  }

  const modulePath = modulePathTextForUseEntry(first);
  if (!modulePath) {
    return undefined;
  }

  const allSameModulePath = entries.every(
    (entry) => modulePathTextForUseEntry(entry) === modulePath,
  );
  if (!allSameModulePath) {
    return undefined;
  }

  return {
    indentation: leadingIndentationAt({ source, offset: startIndex }),
    visibility: parsedUseDecl.visibility === "pub" ? "pub " : "",
    modulePath,
  };
};

const simpleNamedImportEntries = ({
  entries,
  candidateModuleId,
}: {
  entries: readonly {
    moduleId?: string;
    selectionKind: string;
    targetName?: string;
    alias?: string;
  }[];
  candidateModuleId: string;
}): string[] | undefined => {
  if (entries.length === 0) {
    return undefined;
  }

  const names = entries.map((entry) => {
    if (
      entry.moduleId !== candidateModuleId ||
      entry.selectionKind !== "name" ||
      !entry.targetName ||
      (entry.alias !== undefined && entry.alias !== entry.targetName) ||
      !IMPORTABLE_IDENTIFIER_PATTERN.test(entry.targetName)
    ) {
      return undefined;
    }
    return entry.targetName;
  });

  if (names.some((name) => name === undefined)) {
    return undefined;
  }

  return names as string[];
};

const mergeImportEdit = ({
  analysis,
  documentUri,
  candidateModuleId,
  candidateName,
}: {
  analysis: Pick<AutoImportAnalysis, "moduleIdByFilePath" | "semantics" | "graph">;
  documentUri: string;
  candidateModuleId: string;
  candidateName: string;
}): { edit?: TextEdit; modulePath?: string; alreadyImported: boolean } => {
  const filePath = path.resolve(toFilePath(documentUri));
  const currentModuleId = analysis.moduleIdByFilePath.get(filePath);
  if (!currentModuleId) {
    return { alreadyImported: false };
  }

  const semantics = analysis.semantics.get(currentModuleId);
  const source = analysis.graph.modules.get(currentModuleId)?.source;
  if (!semantics || source === undefined) {
    return { alreadyImported: false };
  }

  const lineIndex = new LineIndex(source);

  for (const useDecl of semantics.binding.uses) {
    const names = simpleNamedImportEntries({
      entries: useDecl.entries,
      candidateModuleId,
    });
    if (!names) {
      continue;
    }

    if (names.includes(candidateName)) {
      return { alreadyImported: true };
    }

    const startIndex = useDecl.form.location?.startIndex;
    const endIndex = useDecl.form.location?.endIndex;
    if (typeof startIndex !== "number" || typeof endIndex !== "number") {
      continue;
    }

    const rewriteContext = useDeclRewriteContextFromForm({
      useForm: useDecl.form,
      source,
      startIndex,
    });
    if (!rewriteContext || rewriteContext.modulePath.length === 0) {
      continue;
    }

    const mergedNames = [...new Set([...names, candidateName])];
    return {
      modulePath: rewriteContext.modulePath,
      alreadyImported: false,
      edit: {
        range: {
          start: lineIndex.positionAt(startIndex),
          end: lineIndex.positionAt(endIndex),
        },
        newText: `${rewriteContext.indentation}${rewriteContext.visibility}use ${rewriteContext.modulePath}::{ ${mergedNames.join(", ")} }`,
      },
    };
  }

  return { alreadyImported: false };
};

export const resolveImportEdit = ({
  analysis,
  documentUri,
  candidateModuleId,
  candidateName,
}: {
  analysis: Pick<AutoImportAnalysis, "moduleIdByFilePath" | "semantics" | "graph">;
  documentUri: string;
  candidateModuleId: string;
  candidateName: string;
}): { edit: TextEdit; modulePath: string } | undefined => {
  const currentFilePath = path.resolve(toFilePath(documentUri));
  const currentModuleId = analysis.moduleIdByFilePath.get(currentFilePath);
  const modulePath = importModulePath({
    analysis,
    currentModuleId,
    candidateModuleId,
  });

  const merged = mergeImportEdit({
    analysis,
    documentUri,
    candidateModuleId,
    candidateName,
  });
  if (merged.alreadyImported) {
    return undefined;
  }
  if (merged.edit) {
    return {
      edit: merged.edit,
      modulePath: merged.modulePath ?? modulePath,
    };
  }

  const importLine = `use ${modulePath}::${candidateName}`;
  const insertEdit = insertImportEdit({
    analysis,
    documentUri,
    importLine,
  });
  if (!insertEdit) {
    return undefined;
  }

  return {
    edit: insertEdit,
    modulePath,
  };
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

  const seenCandidates = new Set<string>();

  return candidates
    .map((candidate) => {
      const candidateKey = `${candidate.moduleId}:${candidate.name}`;
      if (seenCandidates.has(candidateKey)) {
        return undefined;
      }
      seenCandidates.add(candidateKey);

      const resolved = resolveImportEdit({
        analysis,
        documentUri,
        candidateModuleId: candidate.moduleId,
        candidateName: candidate.name,
      });
      if (!resolved) {
        return undefined;
      }

      return CodeAction.create(
        `Import ${candidate.name} from ${resolved.modulePath}`,
        {
          changes: {
            [documentUri]: [resolved.edit],
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
