import type binaryen from "binaryen";
import { buildModuleGraph } from "./modules/graph.js";
import { createFsModuleHost } from "./modules/fs-host.js";
import { modulePathToString } from "./modules/path.js";
import type {
  ModuleGraph,
  ModuleHost,
  ModulePath,
  ModuleRoots,
} from "./modules/types.js";
import {
  semanticsPipeline,
  type SemanticsPipelineResult,
} from "./semantics/pipeline.js";
import { createTypingState } from "./semantics/typing/context.js";
import type { DependencySemantics, TypingContext } from "./semantics/typing/types.js";
import { createTypeTranslation, mapDependencySymbolToLocal } from "./semantics/typing/imports.js";
import { typeGenericFunctionBody } from "./semantics/typing/expressions/call.js";
import type { ModuleExportTable } from "./semantics/modules.js";
import type { Diagnostic } from "./diagnostics/index.js";
import { diagnosticFromCode, DiagnosticEmitter, DiagnosticError } from "./diagnostics/index.js";
import { codegenErrorToDiagnostic } from "./codegen/diagnostics.js";
import type { CodegenOptions } from "./codegen/context.js";
import type { ContinuationBackendKind } from "./codegen/codegen.js";

export type LoadModulesOptions = {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
};

export type AnalyzeModulesOptions = {
  graph: ModuleGraph;
};

export type AnalyzeModulesResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
};

export type LowerProgramOptions = {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
};

export type EmitProgramOptions = {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  codegenOptions?: CodegenOptions;
  entryModuleId?: string;
};

export type CompileProgramOptions = LoadModulesOptions &
  Omit<EmitProgramOptions, "graph" | "semantics"> & {
    /**
     * Skip semantic analysis. Useful for tooling that only needs the module
     * graph. Defaults to false.
     */
    skipSemantics?: boolean;
  };

export type CompileProgramResult = {
  graph: ModuleGraph;
  semantics?: Map<string, SemanticsPipelineResult>;
  wasm?: Uint8Array;
  diagnostics: Diagnostic[];
};

export const loadModuleGraph = async (
  options: LoadModulesOptions
): Promise<ModuleGraph> => {
  const host = options.host ?? createFsModuleHost();
  return buildModuleGraph({
    entryPath: options.entryPath,
    host,
    roots: options.roots,
  });
};

export const analyzeModules = ({
  graph,
}: AnalyzeModulesOptions): AnalyzeModulesResult => {
  const order = sortModules(graph);
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];
  let halted = false;

  order.forEach((id) => {
    if (halted) return;
    const module = graph.modules.get(id);
    if (!module) {
      return;
    }
    try {
      const result = semanticsPipeline({
        module,
        graph,
        exports,
        dependencies: semantics,
      });
      semantics.set(id, result);
      exports.set(id, result.exports);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      if (error instanceof DiagnosticError) {
        diagnostics.push(error.diagnostic);
        halted = true;
        return;
      }
      const fallback = diagnosticFromCode({
        code: "TY9999",
        params: {
          kind: "unexpected-error",
          message: error instanceof Error ? error.message : String(error),
        },
        span: { file: module.id, start: 0, end: 0 },
      });
      diagnostics.push(fallback);
      halted = true;
      return;
    }
  });

  return { semantics, diagnostics };
};

export const lowerProgram = ({
  graph,
  semantics,
}: LowerProgramOptions): {
  orderedModules: readonly string[];
  entry: string;
} => {
  const visited = new Set<string>();
  const order: string[] = [];
  const entryId = graph.entry ?? semantics.keys().next().value;

  const visit = (id?: string) => {
    if (!id) return;
    if (visited.has(id)) return;
    visited.add(id);
    const module = graph.modules.get(id);
    if (!module) return;
    module.dependencies.forEach((dep) => visit(moduleIdForPath(dep.path)));
    order.push(id);
  };

  visit(entryId);

  // Ensure we only include modules we have semantics for.
  const filteredOrder = order.filter((id) => semantics.has(id));

  return { orderedModules: filteredOrder, entry: entryId };
};

export const emitProgram = async ({
  graph,
  semantics,
  codegenOptions,
  entryModuleId,
}: EmitProgramOptions): Promise<{
  wasm: Uint8Array;
  module: binaryen.Module;
}> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  materializeImportedGenericInstantiations({ modules, semantics });

  const codegen = await lazyCodegen();
  const result = codegen.codegenProgram({
    modules,
    entryModuleId: targetModuleId,
    options: codegenOptions,
  });
  const binary = result.module.emitBinary();
  const wasm =
    binary instanceof Uint8Array
      ? binary
      : (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (binary as { binary?: Uint8Array }).binary ??
        new Uint8Array();
  return { wasm, module: result.module };
};

export type ContinuationFallbackBundle = {
  preferredKind: ContinuationBackendKind;
  preferredWasm: Uint8Array;
  fallbackWasm?: Uint8Array;
};

export const emitProgramWithContinuationFallback = async ({
  graph,
  semantics,
  codegenOptions,
  entryModuleId,
}: EmitProgramOptions): Promise<ContinuationFallbackBundle> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  materializeImportedGenericInstantiations({ modules, semantics });

  const codegenImpl = await lazyCodegen();
  const { preferredKind, preferred, fallback } =
    codegenImpl.codegenProgramWithContinuationFallback({
      modules,
      entryModuleId: targetModuleId,
      options: codegenOptions,
    });

  const toWasmBytes = (result: { module: binaryen.Module }): Uint8Array => {
    const binary = result.module.emitBinary();
    return binary instanceof Uint8Array
      ? binary
      : (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
          (binary as { binary?: Uint8Array }).binary ??
          new Uint8Array();
  };

  return {
    preferredKind,
    preferredWasm: toWasmBytes(preferred),
    fallbackWasm: fallback ? toWasmBytes(fallback) : undefined,
  };
};

export const compileProgram = async (
  options: CompileProgramOptions
): Promise<CompileProgramResult> => {
  const graph = await loadModuleGraph(options);

  if (options.skipSemantics) {
    return { graph, diagnostics: [...graph.diagnostics] };
  }

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (diagnostics.some((diag) => diag.severity === "error")) {
    return { graph, semantics, diagnostics };
  }

  try {
    const wasmResult = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
    });

    return {
      graph,
      semantics,
      wasm: wasmResult.wasm,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      codegenErrorToDiagnostic(error, { moduleId: options.entryModuleId ?? graph.entry })
    );
    return { graph, semantics, diagnostics };
  }
};

const moduleIdForPath = (path: ModulePath): string => modulePathToString(path);

const sortModules = (graph: ModuleGraph): string[] => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const node = graph.modules.get(id);
    node?.dependencies.forEach((dep) => {
      const depId = moduleIdForPath(dep.path);
      if (graph.modules.has(depId)) {
        visit(depId);
      }
    });
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  graph.modules.forEach((_, id) => visit(id));
  return order;
};

const lazyCodegen = async () =>
  (await import("./codegen/codegen.js")) as typeof import("./codegen/codegen.js");

const materializeImportedGenericInstantiations = ({
  modules,
  semantics,
}: {
  modules: readonly SemanticsPipelineResult[];
  semantics: Map<string, SemanticsPipelineResult>;
}): void => {
  const moduleExports = new Map<string, ModuleExportTable>(
    Array.from(semantics.entries()).map(([id, entry]) => [id, entry.exports])
  );
  const dependencies = new Map<string, DependencySemantics>(
    Array.from(semantics.entries()).map(([id, entry]) => [
      id,
      {
        moduleId: entry.moduleId,
        packageId: entry.binding.packageId,
        symbolTable: entry.symbolTable,
        hir: entry.hir,
        typing: entry.typing,
        decls: entry.binding.decls,
        overloads: collectOverloadOptions(
          entry.binding.overloads,
          entry.binding.importedOverloadOptions
        ),
        exports: entry.exports,
      },
    ])
  );

  const typingContexts = new Map<string, TypingContext>();

  const typingContextFor = (moduleId: string): TypingContext | undefined => {
    const cached = typingContexts.get(moduleId);
    if (cached) {
      return cached;
    }

    const entry = semantics.get(moduleId);
    if (!entry) {
      return undefined;
    }

    const importsByLocal = new Map<number, { moduleId: string; symbol: number }>();
    const importAliasesByModule = new Map<string, Map<number, number>>();
    entry.binding.imports.forEach((imp) => {
      if (!imp.target) {
        return;
      }
      importsByLocal.set(imp.local, imp.target);
      const bucket = importAliasesByModule.get(imp.target.moduleId) ?? new Map();
      bucket.set(imp.target.symbol, imp.local);
      importAliasesByModule.set(imp.target.moduleId, bucket);
    });

    const ctx: TypingContext = {
      symbolTable: entry.symbolTable,
      hir: entry.hir,
      overloads: collectOverloadOptions(
        entry.binding.overloads,
        entry.binding.importedOverloadOptions
      ),
      decls: entry.binding.decls,
      moduleId: entry.moduleId,
      packageId: entry.binding.packageId,
      moduleExports,
      dependencies,
      importsByLocal,
      importAliasesByModule,
      arena: entry.typing.arena,
      table: entry.typing.table,
      effects: entry.typing.effects,
      resolvedExprTypes: new Map(entry.typing.resolvedExprTypes),
      valueTypes: new Map(entry.typing.valueTypes),
      tailResumptions: new Map(entry.typing.tailResumptions),
      callResolution: {
        targets: new Map(
          Array.from(entry.typing.callTargets.entries()).map(([exprId, targets]) => [
            exprId,
            new Map(targets),
          ])
        ),
        typeArguments: new Map(entry.typing.callTypeArguments),
        instanceKeys: new Map(entry.typing.callInstanceKeys),
        traitDispatches: new Set(entry.typing.callTraitDispatches),
      },
      functions: entry.typing.functions,
      objects: entry.typing.objects,
      traits: entry.typing.traits,
      typeAliases: entry.typing.typeAliases,
      primitives: entry.typing.primitives,
      intrinsicTypes: entry.typing.intrinsicTypes,
      diagnostics: new DiagnosticEmitter(),
      memberMetadata: new Map(entry.typing.memberMetadata),
      traitImplsByNominal: new Map(entry.typing.traitImplsByNominal),
      traitImplsByTrait: new Map(entry.typing.traitImplsByTrait),
      traitMethodImpls: new Map(entry.typing.traitMethodImpls),
    };

    typingContexts.set(moduleId, ctx);
    return ctx;
  };

  const dependents = new Map(
    modules.map((entry) => [entry.moduleId, entry] as const)
  );

  const touchedCallees = new Set<string>();

  dependents.forEach((caller) => {
    const callerDep = dependencies.get(caller.moduleId);
    if (!callerDep) {
      return;
    }

    caller.typing.functionInstantiationInfo.forEach((instantiations, localSymbol) => {
      const metadata = (caller.symbolTable.getSymbol(localSymbol).metadata ?? {}) as
        | { import?: { moduleId?: unknown; symbol?: unknown } }
        | undefined;
      const importModuleId = metadata?.import?.moduleId;
      const importSymbol = metadata?.import?.symbol;

      if (typeof importModuleId !== "string" || typeof importSymbol !== "number") {
        return;
      }

      const callee = semantics.get(importModuleId);
      const calleeDep = dependencies.get(importModuleId);
      const calleeCtx = callee ? typingContextFor(callee.moduleId) : undefined;
      if (!callee || !calleeDep || !calleeCtx) {
        return;
      }

      const calleeSignature = callee.typing.functions.getSignature(importSymbol);
      const typeParams = calleeSignature?.typeParams ?? [];
      if (!calleeSignature || typeParams.length === 0) {
        return;
      }

      const translateTypeArg = createTypeTranslation({
        sourceArena: caller.typing.arena,
        targetArena: calleeCtx.arena,
        sourceEffects: caller.typing.effects,
        targetEffects: calleeCtx.effects,
        mapSymbol: (symbol) =>
          mapDependencySymbolToLocal({
            owner: symbol,
            dependency: callerDep,
            ctx: calleeCtx,
            allowUnexported: true,
          }),
      });

      instantiations.forEach((typeArgs) => {
        if (typeArgs.length !== typeParams.length) {
          return;
        }

        const translated = typeArgs.map((arg) => translateTypeArg(arg));
        const substitution = new Map(
          typeParams.map((param, index) => [param.typeParam, translated[index]!] as const)
        );
        typeGenericFunctionBody({
          symbol: importSymbol,
          signature: calleeSignature,
          substitution,
          ctx: calleeCtx,
          state: createTypingState("relaxed"),
        });
        touchedCallees.add(importModuleId);
      });
    });
  });

  touchedCallees.forEach((moduleId) => {
    const entry = semantics.get(moduleId);
    const ctx = typingContexts.get(moduleId);
    if (!entry || !ctx) {
      return;
    }
    entry.typing.functionInstantiationInfo = ctx.functions.snapshotInstantiationInfo();
    entry.typing.functionInstances = ctx.functions.snapshotInstances();
    entry.typing.functionInstanceExprTypes = ctx.functions.snapshotInstanceExprTypes();
    entry.typing.valueTypes = new Map(ctx.valueTypes);
  });
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<number, { functions: readonly { symbol: number }[] }>,
  imported?: ReadonlyMap<number, readonly number[]>
): Map<number, readonly number[]> => {
  const entries = new Map<number, readonly number[]>(
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
