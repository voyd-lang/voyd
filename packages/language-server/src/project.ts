import path from "node:path";
import type { Diagnostic as CompilerDiagnostic } from "@voyd/compiler/diagnostics/index.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline.js";
import { analyzeModules } from "@voyd/compiler/pipeline-shared.js";
import { buildDiagnosticsByUri } from "./project/diagnostics.js";
import {
  createOverlayModuleHost,
  normalizeFilePath,
  resolveEntryPath,
  resolveModuleRoots,
  toFileUri,
} from "./project/files.js";
import { buildSymbolIndex } from "./project/symbol-index.js";
import { LineIndex } from "./project/text.js";
import { autoImportActions } from "./project/auto-imports.js";
import {
  definitionsAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
} from "./project/rename.js";
import { hoverAtPosition } from "./project/hover.js";
import { completionsAtPosition } from "./project/completion.js";
import { buildCompletionIndex } from "./project/completion-index.js";
import type {
  AnalysisInputs,
  CompletionAnalysis,
  ProjectAnalysis,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
  SymbolOccurrence,
} from "./project/types.js";

export {
  autoImportActions,
  definitionsAtPosition,
  completionsAtPosition,
  hoverAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
  resolveEntryPath,
  resolveModuleRoots,
  toFileUri,
};

export type {
  ProjectAnalysis,
  CompletionAnalysis,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
  SymbolOccurrence,
};

export type IncrementalProjectCoreResult = {
  analysis: ProjectCoreAnalysis;
  recomputedModuleIds: readonly string[];
  changedModuleIds: readonly string[];
  incremental: boolean;
};

const normalizeOpenDocumentMap = (
  openDocuments: ReadonlyMap<string, string>,
): Map<string, string> =>
  new Map<string, string>(
    Array.from(openDocuments.entries()).map(([filePath, text]) => [
      normalizeFilePath(filePath),
      text,
    ]),
  );

const buildSourceByFile = ({
  graph,
  openDocuments,
}: {
  graph: ProjectCoreAnalysis["graph"];
  openDocuments: ReadonlyMap<string, string>;
}): Map<string, string> => {
  const sourceByFile = new Map<string, string>();
  openDocuments.forEach((source, filePath) => sourceByFile.set(filePath, source));
  graph.modules.forEach((moduleNode) => {
    if (moduleNode.origin.kind === "file") {
      sourceByFile.set(path.resolve(moduleNode.origin.filePath), moduleNode.source);
    }
  });
  return sourceByFile;
};

const buildModuleIdByFilePath = ({
  graph,
}: {
  graph: ProjectCoreAnalysis["graph"];
}): Map<string, string> => {
  const moduleIdByFilePath = new Map<string, string>();

  graph.modules.forEach((moduleNode, moduleId) => {
    const filePath = path.resolve(
      moduleNode.ast.location?.filePath ??
        (moduleNode.origin.kind === "file" ? moduleNode.origin.filePath : moduleId),
    );
    moduleIdByFilePath.set(filePath, moduleId);
  });

  return moduleIdByFilePath;
};

const resolveChangedModuleIds = ({
  changedFilePaths,
  previousAnalysis,
  nextModuleIdByFilePath,
}: {
  changedFilePaths: ReadonlySet<string> | undefined;
  previousAnalysis: ProjectCoreAnalysis | undefined;
  nextModuleIdByFilePath: ReadonlyMap<string, string>;
}): Set<string> | undefined => {
  if (!previousAnalysis) {
    return undefined;
  }

  if (!changedFilePaths || changedFilePaths.size === 0) {
    return new Set();
  }

  const changedModuleIds = new Set<string>();
  const previousModuleIdByFilePath = previousAnalysis.moduleIdByFilePath;
  changedFilePaths.forEach((filePath) => {
    const normalizedFilePath = path.resolve(filePath);
    const previousModuleId = previousModuleIdByFilePath.get(normalizedFilePath);
    if (previousModuleId) {
      changedModuleIds.add(previousModuleId);
    }

    const nextModuleId = nextModuleIdByFilePath.get(normalizedFilePath);
    if (nextModuleId) {
      changedModuleIds.add(nextModuleId);
    }
  });

  return changedModuleIds;
};

const toProjectCoreAnalysis = ({
  diagnostics,
  graph,
  semantics,
  openDocuments,
}: {
  diagnostics: readonly CompilerDiagnostic[];
  graph: ProjectCoreAnalysis["graph"];
  semantics: ProjectCoreAnalysis["semantics"];
  openDocuments: ReadonlyMap<string, string>;
}): ProjectCoreAnalysis => {
  const sourceByFile = buildSourceByFile({
    graph,
    openDocuments,
  });
  const lineIndexByFile = new Map<string, LineIndex>(
    Array.from(sourceByFile.entries()).map(([filePath, source]) => [
      filePath,
      new LineIndex(source),
    ]),
  );

  const diagnosticsByUri = buildDiagnosticsByUri({
    diagnostics,
    lineIndexByFile,
  });

  const moduleIdByFilePath = buildModuleIdByFilePath({ graph });

  return {
    diagnosticsByUri,
    moduleIdByFilePath,
    graph,
    semantics,
    sourceByFile,
    lineIndexByFile,
  };
};

export const analyzeProjectCore = async ({
  entryPath,
  roots,
  openDocuments,
  host,
}: AnalysisInputs): Promise<ProjectCoreAnalysis> => {
  const normalizedOpenDocuments = normalizeOpenDocumentMap(openDocuments);
  const overlayHost =
    host ?? createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await loadModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host: overlayHost,
  });

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
    recoverFromTypingErrors: true,
  });
  return toProjectCoreAnalysis({
    diagnostics: [...graph.diagnostics, ...semanticDiagnostics],
    graph,
    semantics,
    openDocuments: normalizedOpenDocuments,
  });
};

export const analyzeProjectCoreIncremental = async ({
  entryPath,
  roots,
  openDocuments,
  host,
  previousAnalysis,
  changedFilePaths,
}: AnalysisInputs & {
  previousAnalysis?: ProjectCoreAnalysis;
  changedFilePaths?: ReadonlySet<string>;
}): Promise<IncrementalProjectCoreResult> => {
  const normalizedOpenDocuments = normalizeOpenDocumentMap(openDocuments);
  const overlayHost =
    host ?? createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await loadModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host: overlayHost,
  });
  const nextModuleIdByFilePath = buildModuleIdByFilePath({ graph });
  const changedModuleIds = resolveChangedModuleIds({
    changedFilePaths,
    previousAnalysis,
    nextModuleIdByFilePath,
  });

  const {
    semantics,
    diagnostics: semanticDiagnostics,
    recomputedModuleIds,
  } = analyzeModules({
    graph,
    recoverFromTypingErrors: true,
    previousSemantics: previousAnalysis?.semantics,
    changedModuleIds,
  });

  return {
    analysis: toProjectCoreAnalysis({
      diagnostics: [...graph.diagnostics, ...semanticDiagnostics],
      graph,
      semantics,
      openDocuments: normalizedOpenDocuments,
    }),
    recomputedModuleIds,
    changedModuleIds: Array.from(changedModuleIds ?? []),
    incremental: changedModuleIds !== undefined,
  };
};

export const buildProjectNavigationIndex = async ({
  analysis,
}: {
  analysis: ProjectCoreAnalysis;
}): Promise<ProjectNavigationIndex> => {
  const symbolIndex = await buildSymbolIndex({
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
    includeWorkspaceExports: false,
  });

  return {
    occurrencesByUri: symbolIndex.occurrencesByUri,
    declarationsByKey: symbolIndex.declarationsByKey,
    documentationByCanonicalKey: symbolIndex.documentationByCanonicalKey,
    typeInfoByCanonicalKey: symbolIndex.typeInfoByCanonicalKey,
  };
};

export const buildProjectNavigationIndexForModules = async ({
  analysis,
  moduleIds,
}: {
  analysis: ProjectCoreAnalysis;
  moduleIds: ReadonlySet<string>;
}): Promise<ProjectNavigationIndex> => {
  const symbolIndex = await buildSymbolIndex({
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
    includeWorkspaceExports: false,
    targetModuleIds: moduleIds,
  });

  return {
    occurrencesByUri: symbolIndex.occurrencesByUri,
    declarationsByKey: symbolIndex.declarationsByKey,
    documentationByCanonicalKey: symbolIndex.documentationByCanonicalKey,
    typeInfoByCanonicalKey: symbolIndex.typeInfoByCanonicalKey,
  };
};

export const analyzeProject = async (inputs: AnalysisInputs): Promise<ProjectAnalysis> => {
  const analysis = await analyzeProjectCore(inputs);

  const symbolIndex = await buildSymbolIndex({
    graph: analysis.graph,
    semantics: analysis.semantics,
    roots: inputs.roots,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
    includeWorkspaceExports: true,
  });
  const completionIndex = buildCompletionIndex({
    semantics: analysis.semantics,
    occurrencesByUri: symbolIndex.occurrencesByUri,
    lineIndexByFile: analysis.lineIndexByFile,
    exportsByName: symbolIndex.exportsByName,
  });

  return {
    diagnosticsByUri: analysis.diagnosticsByUri,
    occurrencesByUri: symbolIndex.occurrencesByUri,
    declarationsByKey: symbolIndex.declarationsByKey,
    documentationByCanonicalKey: symbolIndex.documentationByCanonicalKey,
    typeInfoByCanonicalKey: symbolIndex.typeInfoByCanonicalKey,
    exportsByName: symbolIndex.exportsByName,
    completionIndex,
    moduleIdByFilePath: analysis.moduleIdByFilePath,
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
  };
};
