import type binaryen from "binaryen";
import { modulePathToString } from "./modules/path.js";
import type {
  ModuleGraph,
  ModuleHost,
  ModulePath,
  ModuleRoots,
} from "./modules/types.js";
import type { TestAttribute } from "./parser/attributes.js";
import {
  semanticsPipeline,
  type SemanticsPipelineResult,
} from "./semantics/pipeline.js";
import { monomorphizeProgram } from "./semantics/linking.js";
import type { Diagnostic } from "./diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "./diagnostics/index.js";
import { codegenErrorToDiagnostic } from "./codegen/diagnostics.js";
import type { CodegenOptions } from "./codegen/context.js";
import type { ContinuationBackendKind } from "./codegen/codegen.js";
import { ModuleExportTable } from "./semantics/modules.js";
import { createTypeArena } from "./semantics/typing/type-arena.js";
import { createEffectInterner, createEffectTable } from "./semantics/effects/effect-table.js";
import { buildProgramCodegenView } from "./semantics/codegen-view/index.js";
import { formatTestExportName } from "./tests/exports.js";

export type LoadModulesOptions = {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
};

export type AnalyzeModulesOptions = {
  graph: ModuleGraph;
  includeTests?: boolean;
  testScope?: TestScope;
};

export type AnalyzeModulesResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
  tests: readonly TestCase[];
};

export type TestScope = "all" | "entry";

export type TestCase = {
  id: string;
  exportName?: string;
  moduleId: string;
  modulePath: string;
  description?: string;
  modifiers: { skip?: boolean; only?: boolean };
  location?: { filePath: string; startLine: number; startColumn: number };
  effectful: boolean;
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
  /**
   * Whether to run the semantics linking stage prior to codegen.
   * Defaults to true.
   */
  linkSemantics?: boolean;
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

export const analyzeModules = ({
  graph,
  includeTests,
  testScope,
}: AnalyzeModulesOptions): AnalyzeModulesResult => {
  const order = sortModules(graph);
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];
  let halted = false;

  const arena = createTypeArena();
  const effectInterner = createEffectInterner();

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
        typing: { arena, effects: createEffectTable({ interner: effectInterner }) },
        includeTests,
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

  const tests = includeTests
    ? collectTests({ graph, semantics, scope: testScope ?? "all" })
    : [];
  return { semantics, diagnostics, tests };
};

const collectTests = ({
  graph,
  semantics,
  scope,
}: {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  scope: TestScope;
}): TestCase[] => {
  const tests: TestCase[] = [];
  const entryId = graph.entry ?? semantics.keys().next().value;

  semantics.forEach((entry, moduleId) => {
    if (scope === "entry" && moduleId !== entryId) {
      return;
    }
    const moduleNode = graph.modules.get(moduleId);
    if (!moduleNode) {
      return;
    }

    const modulePath = modulePathToString(moduleNode.path);
    entry.binding.functions.forEach((fn) => {
      const attributes = fn.form?.attributes as
        | { test?: TestAttribute }
        | undefined;
      const test = attributes?.test;
      if (!test) {
        return;
      }

      const location = fn.form?.location;
      const effectRow = entry.typing.effects.getFunctionEffect(fn.symbol);
      const effectful =
        typeof effectRow === "number" &&
        !entry.typing.effects.isEmpty(effectRow);

      tests.push({
        id: test.id,
        exportName: formatTestExportName({ moduleId, testId: test.id }),
        moduleId,
        modulePath,
        description: test.description,
        modifiers: normalizeTestModifiers(test.modifiers),
        location: location
          ? {
              filePath: location.filePath,
              startLine: location.startLine,
              startColumn: location.startColumn + 1,
            }
          : undefined,
        effectful,
      });
    });
  });

  return tests;
};

const normalizeTestModifiers = (
  modifiers?: TestAttribute["modifiers"]
): { skip?: boolean; only?: boolean } => {
  if (!modifiers) {
    return {};
  }

  return {
    ...(modifiers.skip ? { skip: true } : {}),
    ...(modifiers.only ? { only: true } : {}),
  };
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
  linkSemantics,
}: EmitProgramOptions): Promise<{
  wasm: Uint8Array;
  module: binaryen.Module;
  diagnostics: Diagnostic[];
}> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const codegen = await lazyCodegen();
  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const result = codegen.codegenProgram({
    program,
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
  return { wasm, module: result.module, diagnostics: result.diagnostics };
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
  linkSemantics,
}: EmitProgramOptions): Promise<ContinuationFallbackBundle> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });

  const codegenImpl = await lazyCodegen();
  const { preferredKind, preferred, fallback } =
    codegenImpl.codegenProgramWithContinuationFallback({
      program,
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

export type LoadModuleGraphFn = (
  options: LoadModulesOptions
) => Promise<ModuleGraph>;

export const compileProgramWithLoader = async (
  options: CompileProgramOptions,
  loadModuleGraph: LoadModuleGraphFn
): Promise<CompileProgramResult> => {
  const graph = await loadModuleGraph(options);

  if (options.skipSemantics) {
    return { graph, diagnostics: [...graph.diagnostics] };
  }

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (diagnostics.some((diag) => diag.severity === "error")) {
    return { graph, semantics, diagnostics };
  }

  const shouldLinkSemantics = options.linkSemantics !== false;

  try {
    const wasmResult = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
      linkSemantics: shouldLinkSemantics,
    });

    diagnostics.push(...wasmResult.diagnostics);

    if (diagnostics.some((diag) => diag.severity === "error")) {
      return { graph, semantics, diagnostics };
    }

    return { graph, semantics, wasm: wasmResult.wasm, diagnostics };
  } catch (error) {
    diagnostics.push(
      codegenErrorToDiagnostic(error, {
        moduleId: options.entryModuleId ?? graph.entry,
      })
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
  (await import(
    "./codegen/codegen.js"
  )) as typeof import("./codegen/codegen.js");
