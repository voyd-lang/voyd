import type { Form } from "../parser/index.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/pipeline.js";
import type { BindingResult, BoundOverloadSet } from "./binding/pipeline.js";
import type { HirGraph } from "./hir/index.js";
import { createHirBuilder } from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/pipeline.js";
import { runTypingPipeline, type TypingResult } from "./typing/pipeline.js";
import { specializeOverloadCallees } from "./typing/specialize-overloads.js";
import { toSourceSpan } from "./utils.js";
import type { OverloadSetId, SymbolId } from "./ids.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
}

export const semanticsPipeline = (form: Form): SemanticsPipelineResult => {
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  const modulePath = form.location?.filePath ?? "<module>";
  const symbolTable: SymbolTable = new SymbolTable({
    rootOwner: form.syntaxId,
  });
  const moduleSymbol = symbolTable.declare({
    name: modulePath,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
  });
  ensureNoBindingErrors(binding);

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
    overloads: collectOverloadOptions(binding.overloads),
    decls: binding.decls,
  });

  specializeOverloadCallees(hir, typing);

  return { binding, symbolTable, hir, typing };
};

const ensureNoBindingErrors = (binding: BindingResult): void => {
  const errors = binding.diagnostics.filter(
    (diag) => diag.severity === "error"
  );
  if (errors.length === 0) {
    return;
  }

  const message =
    errors.length === 1
      ? errors[0]!.message
      : errors
          .map(
            (diag) => `${diag.message} (${diag.span.file}:${diag.span.start})`
          )
          .join("\n");
  throw new Error(message);
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<OverloadSetId, BoundOverloadSet>
): Map<OverloadSetId, readonly SymbolId[]> =>
  new Map(
    Array.from(overloads.entries()).map(([id, set]) => [
      id,
      set.functions.map((fn) => fn.symbol),
    ])
  );
