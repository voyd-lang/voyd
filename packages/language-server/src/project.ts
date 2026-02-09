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
import type { AnalysisInputs, ProjectAnalysis, SymbolOccurrence } from "./project/types.js";

export {
  autoImportActions,
  definitionsAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
  resolveEntryPath,
  resolveModuleRoots,
  toFileUri,
};

export type { ProjectAnalysis, SymbolOccurrence };

export const analyzeProject = async ({
  entryPath,
  roots,
  openDocuments,
}: AnalysisInputs): Promise<ProjectAnalysis> => {
  const normalizedOpenDocuments = new Map<string, string>(
    Array.from(openDocuments.entries()).map(([filePath, text]) => [
      normalizeFilePath(filePath),
      text,
    ]),
  );

  const host = createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await buildModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host,
  });

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  const sourceByFile = new Map<string, string>();
  normalizedOpenDocuments.forEach((source, filePath) => sourceByFile.set(filePath, source));
  graph.modules.forEach((moduleNode) => {
    if (moduleNode.origin.kind === "file") {
      sourceByFile.set(path.resolve(moduleNode.origin.filePath), moduleNode.source);
    }
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

  const symbolIndex = await buildSymbolIndex({
    graph,
    semantics,
    roots,
    sourceByFile,
    lineIndexByFile,
  });

  return {
    diagnosticsByUri,
    occurrencesByUri: symbolIndex.occurrencesByUri,
    declarationsByKey: symbolIndex.declarationsByKey,
    exportsByName: symbolIndex.exportsByName,
    moduleIdByFilePath: symbolIndex.moduleIdByFilePath,
    graph,
    semantics,
  };
};
