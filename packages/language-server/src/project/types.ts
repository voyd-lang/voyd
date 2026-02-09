import type { ModuleGraph, ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import type { SymbolId } from "@voyd/compiler/semantics/ids.js";
import type { Diagnostic, Range } from "vscode-languageserver/lib/node/main.js";

export type SymbolOccurrence = {
  canonicalKey: string;
  moduleId: string;
  symbol: SymbolId;
  uri: string;
  range: Range;
  name: string;
  kind: "declaration" | "reference";
};

export type SymbolRef = {
  moduleId: string;
  symbol: SymbolId;
};

export type ExportCandidate = {
  moduleId: string;
  symbol: SymbolId;
  name: string;
  kind: string;
};

export type AnalysisInputs = {
  entryPath: string;
  roots: ModuleRoots;
  openDocuments: ReadonlyMap<string, string>;
};

export type ProjectAnalysis = {
  diagnosticsByUri: ReadonlyMap<string, Diagnostic[]>;
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  declarationsByKey: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
  moduleIdByFilePath: ReadonlyMap<string, string>;
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
};
