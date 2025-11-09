import type { Form } from "../parser/index.js";
import { createSymbolTable, type SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/pipeline.js";
import type { HirGraph } from "./hir/index.js";
import { createHirBuilder } from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/pipeline.js";
import { runTypingPipeline, type TypingResult } from "./typing/pipeline.js";
import { toSourceSpan } from "./utils.js";

export interface SemanticsPipelineResult {
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
}

export const semanticsPipeline = (form: Form): SemanticsPipelineResult => {
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  const modulePath = form.location?.filePath ?? "<module>";
  const symbolTable = createSymbolTable({ rootOwner: form.syntaxId });
  const moduleSymbol = symbolTable.declare({
    name: modulePath,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
  });

  const builder = createHirBuilder({
    path: modulePath,
    scope: moduleSymbol,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: form.syntaxId,
  });

  const typing = runTypingPipeline({
    symbolTable,
    hir,
  });

  return { symbolTable, hir, typing };
};
