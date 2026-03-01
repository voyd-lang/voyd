import type {
  ModuleGraph,
  ModuleHost,
  ModuleRoots,
} from "@voyd/compiler/modules/types.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import type { ScopeId, SymbolId } from "@voyd/compiler/semantics/ids.js";
import type { Diagnostic, Range } from "vscode-languageserver/lib/node/main.js";
import type { LineIndex } from "./text.js";

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

export type CompletionScopedNodeSpan = {
  start: number;
  end: number;
  scope: ScopeId;
  width: number;
};

export type CompletionSymbolLookup = {
  declarationOffsetBySymbol: ReadonlyMap<SymbolId, number>;
  canonicalKeyBySymbol: ReadonlyMap<SymbolId, string>;
};

export type CompletionExportEntry = {
  name: string;
  candidates: readonly ExportCandidate[];
};

export type CompletionIndex = {
  scopedNodesByModuleId: ReadonlyMap<string, ReadonlyMap<string, readonly CompletionScopedNodeSpan[]>>;
  symbolLookupByUri: ReadonlyMap<string, ReadonlyMap<string, CompletionSymbolLookup>>;
  exportEntriesByFirstCharacter: ReadonlyMap<string, readonly CompletionExportEntry[]>;
};

export type AnalysisInputs = {
  entryPath: string;
  roots: ModuleRoots;
  openDocuments: ReadonlyMap<string, string>;
  host?: ModuleHost;
};

export type ProjectCoreAnalysis = {
  diagnosticsByUri: ReadonlyMap<string, Diagnostic[]>;
  moduleIdByFilePath: ReadonlyMap<string, string>;
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  sourceByFile: ReadonlyMap<string, string>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
};

export type ProjectNavigationIndex = {
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  declarationsByKey: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  documentationByCanonicalKey: ReadonlyMap<string, string>;
  typeInfoByCanonicalKey: ReadonlyMap<string, string>;
  typeExpandedInfoByCanonicalKey: ReadonlyMap<string, string>;
};

export type ProjectAnalysis = ProjectCoreAnalysis &
  ProjectNavigationIndex & {
    exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
    completionIndex: CompletionIndex;
  };

export type NavigationAnalysis = Pick<
  ProjectAnalysis,
  | "occurrencesByUri"
  | "declarationsByKey"
  | "documentationByCanonicalKey"
  | "typeInfoByCanonicalKey"
  | "typeExpandedInfoByCanonicalKey"
>;

export type AutoImportAnalysis = Pick<
  ProjectAnalysis,
  "moduleIdByFilePath" | "semantics" | "graph"
> & {
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
};

export type CompletionAnalysis = Pick<
  ProjectAnalysis,
  | "occurrencesByUri"
  | "declarationsByKey"
  | "documentationByCanonicalKey"
  | "typeInfoByCanonicalKey"
  | "moduleIdByFilePath"
  | "semantics"
  | "graph"
  | "sourceByFile"
  | "lineIndexByFile"
  | "completionIndex"
> & {
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
};
