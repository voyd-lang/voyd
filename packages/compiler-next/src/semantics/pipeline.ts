import type { Form } from "../parser/index.js";
import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import type { HirGraph } from "./hir/index.js";
import { createHirBuilder, type HirVisibility } from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/lowering.js";
import { analyzeLambdaCaptures } from "./lowering/captures.js";
import { runTypingPipeline, type TypingResult } from "./typing/typing.js";
import { specializeOverloadCallees } from "./typing/specialize-overloads.js";
import { toSourceSpan } from "./utils.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { ModuleExportTable } from "./modules.js";
import type { DependencySemantics } from "./typing/types.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { DiagnosticError } from "../diagnostics/index.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  moduleId: string;
  exports: ModuleExportTable;
  diagnostics: readonly Diagnostic[];
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
    dependencies: dependencies
      ? new Map(
          Array.from(dependencies.entries()).map(([id, entry]) => [
            id,
            entry.binding,
          ])
        )
      : undefined,
  });
  ensureNoBindingErrors(binding);

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
  analyzeLambdaCaptures({
    hir,
    symbolTable,
    scopeByNode: binding.scopeByNode,
  });

  const typing = runTypingPipeline({
    symbolTable,
    hir,
    overloads: collectOverloadOptions(
      binding.overloads,
      binding.importedOverloadOptions
    ),
    decls: binding.decls,
    imports: binding.imports,
    moduleId: module.id,
    moduleExports: exports ?? new Map(),
    availableSemantics: projectDependencySemantics(dependencies),
  });

  specializeOverloadCallees(hir, typing);

  const diagnostics: Diagnostic[] = [
    ...binding.diagnostics,
    ...typing.diagnostics,
  ];

  return {
    binding,
    symbolTable,
    hir,
    typing,
    moduleId: module.id,
    exports: collectModuleExports({
      hir,
      symbolTable,
      moduleId: module.id,
      binding,
    }),
    diagnostics,
  };
};

const ensureNoBindingErrors = (binding: BindingResult): void => {
  const errors = binding.diagnostics.filter(
    (diag) => diag.severity === "error"
  );
  if (errors.length === 0) {
    return;
  }
  throw new DiagnosticError(errors[0]!);
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<OverloadSetId, BoundOverloadSet>,
  imported?: ReadonlyMap<OverloadSetId, readonly SymbolId[]>
): Map<OverloadSetId, readonly SymbolId[]> => {
  const entries = new Map<OverloadSetId, readonly SymbolId[]>(
    Array.from(overloads.entries()).map(([id, set]) => [
      id,
      set.functions.map((fn) => fn.symbol),
    ])
  );
  if (imported) {
    imported.forEach((symbols, id) => {
      entries.set(id, symbols);
    });
  }
  return entries;
};

const collectModuleExports = ({
  hir,
  symbolTable,
  moduleId,
  binding,
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
  binding: BindingResult;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();
  hir.module.exports.forEach((entry) => {
    const record = symbolTable.getSymbol(entry.symbol);
    const name = entry.alias ?? record.name;
    const existing = table.get(name);
    const symbols = existing
      ? new Set(existing.symbols ?? [existing.symbol])
      : new Set<SymbolId>();
    symbols.add(entry.symbol);
    const overloadSet =
      binding.overloadBySymbol.get(entry.symbol) ?? existing?.overloadSet;
    table.set(name, {
      name,
      symbol: existing?.symbol ?? entry.symbol,
      symbols: Array.from(symbols),
      overloadSet,
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
