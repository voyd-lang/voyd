import path from "node:path";
import type { Diagnostic as CompilerDiagnostic } from "@voyd-lang/compiler/diagnostics/index.js";
import { modulePathToString } from "@voyd-lang/compiler/modules/path.js";
import type { ModuleGraph, ModuleNode } from "@voyd-lang/compiler/modules/types.js";
import { loadModuleGraph } from "@voyd-lang/compiler/pipeline.js";
import { analyzeModules } from "@voyd-lang/compiler/pipeline-shared.js";
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

const PROJECT_ANALYSIS_CANCELLED_CODE = "VOYD_PROJECT_ANALYSIS_CANCELLED";

const createProjectAnalysisCancelledError = (): Error & { code: string } => {
  const error = new Error("project analysis cancelled") as Error & {
    code: string;
  };
  error.name = "ProjectAnalysisCancelledError";
  error.code = PROJECT_ANALYSIS_CANCELLED_CODE;
  return error;
};

export const isProjectAnalysisCancelledError = (
  error: unknown,
): error is Error & { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === PROJECT_ANALYSIS_CANCELLED_CODE;

export const throwIfProjectAnalysisCancelled = (
  isCancelled: (() => boolean) | undefined,
): void => {
  if (!isCancelled?.()) {
    return;
  }

  throw createProjectAnalysisCancelledError();
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

const dependencyIdsFor = (moduleNode: ModuleNode): readonly string[] =>
  moduleNode.dependencies
    .map((dependency) => modulePathToString(dependency.path))
    .sort();

const sameDependencies = ({
  previous,
  next,
}: {
  previous: ModuleNode;
  next: ModuleNode;
}): boolean => {
  const previousDependencyIds = dependencyIdsFor(previous);
  const nextDependencyIds = dependencyIdsFor(next);
  return (
    previousDependencyIds.length === nextDependencyIds.length &&
    previousDependencyIds.every((dependencyId, index) => dependencyId === nextDependencyIds[index])
  );
};

const diagnosticsForChangedFiles = ({
  diagnostics,
  changedFilePaths,
}: {
  diagnostics: readonly CompilerDiagnostic[];
  changedFilePaths: ReadonlySet<string>;
}): CompilerDiagnostic[] =>
  diagnostics.filter((diagnostic) =>
    changedFilePaths.has(path.resolve(diagnostic.span.file)),
  );

const tryReusePreviousGraph = async ({
  previousAnalysis,
  changedFilePaths,
  roots,
  host,
}: {
  previousAnalysis: ProjectCoreAnalysis | undefined;
  changedFilePaths: ReadonlySet<string> | undefined;
  roots: AnalysisInputs["roots"];
  host: NonNullable<AnalysisInputs["host"]>;
}): Promise<ModuleGraph | undefined> => {
  if (!previousAnalysis || !changedFilePaths || changedFilePaths.size === 0) {
    return undefined;
  }

  if (previousAnalysis.graph.diagnostics.length > 0) {
    return undefined;
  }

  const previousGraph = previousAnalysis.graph;
  const changedPaths = changedFilePaths;
  const updatedModules = new Map(previousGraph.modules);
  const updatedDiagnostics: CompilerDiagnostic[] = [];

  for (const changedFilePath of changedPaths) {
    const normalizedFilePath = path.resolve(changedFilePath);
    const moduleId = previousAnalysis.moduleIdByFilePath.get(normalizedFilePath);
    if (!moduleId) {
      return undefined;
    }

    const previousModule = previousGraph.modules.get(moduleId);
    if (!previousModule || previousModule.origin.kind !== "file") {
      return undefined;
    }
    if (path.resolve(previousModule.origin.filePath) !== normalizedFilePath) {
      return undefined;
    }

    const changedModuleGraph = await loadModuleGraph({
      entryPath: normalizedFilePath,
      roots,
      host,
    });
    const changedModule = changedModuleGraph.modules.get(moduleId);
    if (!changedModule || changedModule.origin.kind !== "file") {
      return undefined;
    }

    if (!sameDependencies({ previous: previousModule, next: changedModule })) {
      return undefined;
    }

    updatedModules.set(moduleId, changedModule);
    updatedDiagnostics.push(
      ...diagnosticsForChangedFiles({
        diagnostics: changedModuleGraph.diagnostics,
        changedFilePaths: changedPaths,
      }),
    );
  }

  const unchangedDiagnostics = previousGraph.diagnostics.filter(
    (diagnostic) => !changedPaths.has(path.resolve(diagnostic.span.file)),
  );

  return {
    entry: previousGraph.entry,
    modules: updatedModules,
    diagnostics: [...unchangedDiagnostics, ...updatedDiagnostics],
  };
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
  isCancelled,
}: AnalysisInputs & {
  isCancelled?: () => boolean;
}): Promise<ProjectCoreAnalysis> => {
  throwIfProjectAnalysisCancelled(isCancelled);

  const normalizedOpenDocuments = normalizeOpenDocumentMap(openDocuments);
  const overlayHost =
    host ?? createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await loadModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host: overlayHost,
  });
  throwIfProjectAnalysisCancelled(isCancelled);

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
    recoverFromTypingErrors: true,
    isCancelled,
  });
  throwIfProjectAnalysisCancelled(isCancelled);

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
  isCancelled,
}: AnalysisInputs & {
  previousAnalysis?: ProjectCoreAnalysis;
  changedFilePaths?: ReadonlySet<string>;
  isCancelled?: () => boolean;
}): Promise<IncrementalProjectCoreResult> => {
  throwIfProjectAnalysisCancelled(isCancelled);

  const normalizedOpenDocuments = normalizeOpenDocumentMap(openDocuments);
  const overlayHost =
    host ?? createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const normalizedChangedFilePaths = changedFilePaths
    ? new Set(Array.from(changedFilePaths).map((filePath) => path.resolve(filePath)))
    : undefined;
  const graph =
    (await tryReusePreviousGraph({
      previousAnalysis,
      changedFilePaths: normalizedChangedFilePaths,
      roots,
      host: overlayHost,
    })) ??
    (await loadModuleGraph({
      entryPath: path.resolve(entryPath),
      roots,
      host: overlayHost,
    }));
  throwIfProjectAnalysisCancelled(isCancelled);

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
    isCancelled,
  });
  throwIfProjectAnalysisCancelled(isCancelled);

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
  isCancelled,
}: {
  analysis: ProjectCoreAnalysis;
  isCancelled?: () => boolean;
}): Promise<ProjectNavigationIndex> => {
  throwIfProjectAnalysisCancelled(isCancelled);

  const symbolIndex = await buildSymbolIndex({
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
    includeWorkspaceExports: false,
    isCancelled,
  });
  throwIfProjectAnalysisCancelled(isCancelled);

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
  isCancelled,
}: {
  analysis: ProjectCoreAnalysis;
  moduleIds: ReadonlySet<string>;
  isCancelled?: () => boolean;
}): Promise<ProjectNavigationIndex> => {
  throwIfProjectAnalysisCancelled(isCancelled);

  const symbolIndex = await buildSymbolIndex({
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
    includeWorkspaceExports: false,
    targetModuleIds: moduleIds,
    isCancelled,
  });
  throwIfProjectAnalysisCancelled(isCancelled);

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
