import type { Form } from "../parser/index.js";
import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import type { HirGraph } from "./hir/index.js";
import { createHirBuilder, type HirVisibility } from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/lowering.js";
import { runTypingPipeline, type TypingResult } from "./typing/typing.js";
import { specializeOverloadCallees } from "./typing/specialize-overloads.js";
import { toSourceSpan } from "./utils.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { ModuleExportTable } from "./modules.js";
import type { DependencySemantics } from "./typing/types.js";
import { tagIntrinsicSymbols } from "./intrinsics.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  moduleId: string;
  exports: ModuleExportTable;
}

export interface SemanticsPipelineOptions {
  module: ModuleNode;
  graph: ModuleGraph;
  exports?: Map<string, ModuleExportTable>;
  dependencies?: Map<string, SemanticsPipelineResult>;
}

type SemanticsPipelineInput = SemanticsPipelineOptions | Form;

export const semanticsPipeline = (
  input: SemanticsPipelineInput
): SemanticsPipelineResult => {
  const { module, graph, exports, dependencies } =
    normalizeSemanticsInput(input);
  const form = module.ast;
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  const modulePath = form.location?.filePath ?? "<module>";
  const symbolTable: SymbolTable = new SymbolTable({
    rootOwner: form.syntaxId,
  });
  const moduleSymbol = symbolTable.declare({
    name: module.id,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
    module,
    graph,
    moduleExports: exports ?? new Map(),
  });
  ensureNoBindingErrors(binding);
  tagIntrinsicSymbols({ binding, moduleId: module.id });

  const builder = createHirBuilder({
    path: module.id,
    scope: moduleSymbol,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: form.syntaxId,
    moduleId: module.id,
  });

  const typing = runTypingPipeline({
    symbolTable,
    hir,
    overloads: collectOverloadOptions(binding.overloads),
    decls: binding.decls,
    imports: binding.imports,
    moduleId: module.id,
    moduleExports: exports ?? new Map(),
    availableSemantics: projectDependencySemantics(dependencies),
  });

  specializeOverloadCallees(hir, typing);

  return {
    binding,
    symbolTable,
    hir,
    typing,
    moduleId: module.id,
    exports: collectModuleExports({ hir, symbolTable, moduleId: module.id }),
  };
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

const collectModuleExports = ({
  hir,
  symbolTable,
  moduleId,
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();
  hir.module.exports.forEach((entry) => {
    const record = symbolTable.getSymbol(entry.symbol);
    const name = entry.alias ?? record.name;
    table.set(name, {
      name,
      symbol: entry.symbol,
      moduleId,
      kind: record.kind,
      visibility: entry.visibility,
    });
  });
  return table;
};

const projectDependencySemantics = (
  dependencies?: Map<string, SemanticsPipelineResult>
): Map<string, DependencySemantics> => {
  if (!dependencies || dependencies.size === 0) {
    return new Map();
  }

  return new Map(
    Array.from(dependencies.entries()).map(([id, entry]) => [
      id,
      {
        moduleId: entry.moduleId,
        symbolTable: entry.symbolTable,
        hir: entry.hir,
        typing: entry.typing,
        decls: entry.binding.decls,
        overloads: collectOverloadOptions(entry.binding.overloads),
        exports: entry.exports,
      },
    ])
  );
};

const normalizeSemanticsInput = (
  input: SemanticsPipelineInput
): SemanticsPipelineOptions => {
  if (!isForm(input)) {
    return input;
  }

  const form = input;
  const id = form.location?.filePath ?? "<module>";
  const path: ModulePath = { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id,
    path,
    origin: {
      kind: "file",
      filePath: id,
    },
    ast: form,
    source: "",
    dependencies: [],
  };

  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };

  return {
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
  };
};
