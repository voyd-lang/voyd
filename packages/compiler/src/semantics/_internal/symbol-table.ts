import type { SymbolTable } from "../binder/index.js";
import type { SemanticsPipelineResult } from "../pipeline.js";

export const getSymbolTable = (entry: SemanticsPipelineResult): SymbolTable => {
  const table = (entry as unknown as { symbolTable?: SymbolTable }).symbolTable;
  if (!table) {
    throw new Error("SemanticsPipelineResult is missing symbolTable");
  }
  return table;
};

