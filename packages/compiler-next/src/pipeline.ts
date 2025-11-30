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
import type { ModuleExportTable } from "./semantics/modules.js";
import type { Diagnostic } from "./diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "./diagnostics/index.js";
import { codegenErrorToDiagnostic } from "./codegen/diagnostics.js";

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
  codegenOptions?: { optimize?: boolean; validate?: boolean };
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
