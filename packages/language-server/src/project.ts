import path from "node:path";
import { buildModuleGraph } from "@voyd/compiler/modules/graph.js";
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
import type {
  AnalysisInputs,
  ProjectAnalysis,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
  SymbolOccurrence,
} from "./project/types.js";

export {
  autoImportActions,
  definitionsAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
  resolveEntryPath,
  resolveModuleRoots,
  toFileUri,
};

export type {
  ProjectAnalysis,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
  SymbolOccurrence,
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

export const analyzeProjectCore = async ({
  entryPath,
  roots,
  openDocuments,
  host,
}: AnalysisInputs): Promise<ProjectCoreAnalysis> => {
  const normalizedOpenDocuments = normalizeOpenDocumentMap(openDocuments);
  const overlayHost =
    host ?? createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await buildModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host: overlayHost,
  });

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  const sourceByFile = buildSourceByFile({
    graph,
    openDocuments: normalizedOpenDocuments,
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

  return {
    diagnosticsByUri: analysis.diagnosticsByUri,
    occurrencesByUri: symbolIndex.occurrencesByUri,
    declarationsByKey: symbolIndex.declarationsByKey,
    exportsByName: symbolIndex.exportsByName,
    moduleIdByFilePath: analysis.moduleIdByFilePath,
    graph: analysis.graph,
    semantics: analysis.semantics,
    sourceByFile: analysis.sourceByFile,
    lineIndexByFile: analysis.lineIndexByFile,
  };
};
