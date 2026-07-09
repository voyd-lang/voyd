import type binaryen from "binaryen";
import { modulePathToString } from "./modules/path.js";
import type {
  ModuleGraph,
  ModuleHost,
  ModulePath,
  ModuleRoots,
} from "./modules/types.js";
import type { TestAttribute } from "./parser/attributes.js";
import { type SemanticsPipelineResult } from "./semantics/pipeline.js";
import { monomorphizeProgram } from "./semantics/linking.js";
import type { Diagnostic } from "./diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "./diagnostics/index.js";
import { codegenErrorToDiagnostic } from "./codegen/diagnostics.js";
import type { CodegenOptions } from "./codegen/context.js";
import type { ContinuationBackendKind } from "./codegen/codegen.js";
import { buildProgramCodegenView } from "./semantics/codegen-view/index.js";
import { optimizeProgram } from "./optimize/pipeline.js";
import { analyzeModuleSemantics } from "./modules/semantic-analysis.js";
import type { ReusableDependencySemanticsSnapshot } from "./modules/semantic-analysis.js";
import {
  commitDependencySnapshot,
  createCompilerDependencySnapshotCache,
  prepareDependencySnapshotReuse,
  type CompilerDependencySnapshotCache,
} from "./modules/dependency-snapshot-cache.js";
import type { EffectInterner } from "./semantics/effects/effect-table.js";
import type { TypeArena } from "./semantics/typing/type-arena.js";
import { formatTestExportName } from "./tests/exports.js";
import type { SourceSpan, SymbolId } from "./semantics/ids.js";
import { getSymbolTable } from "./semantics/_internal/symbol-table.js";
import { formatEffectRow } from "./semantics/effects/format.js";
import {
  completeCompilerPerfSession,
  isCompilerPerfEnabled,
  markCompilerPerfPhaseDuration,
  recordCompilerPerfDuration,
  startCompilerPerfPhase,
  startCompilerPerfSession,
} from "./perf.js";

export {
  createCompilerDependencySnapshotCache,
  type CompilerDependencySnapshotCache,
};

export type LoadModulesOptions = {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
};

export type AnalyzeModulesOptions = {
  graph: ModuleGraph;
  includeTests?: boolean;
  testScope?: TestScope;
  recoverFromTypingErrors?: boolean;
  captureDependencySnapshot?: boolean;
  previousSemantics?: ReadonlyMap<string, SemanticsPipelineResult>;
  changedModuleIds?: ReadonlySet<string>;
  typingState?: {
    arena: TypeArena;
    effectInterner: EffectInterner;
  };
  isCancelled?: () => boolean;
};

export type AnalyzeModulesResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
  tests: readonly TestCase[];
  recomputedModuleIds: readonly string[];
  dependencySnapshot?: ReusableDependencySemanticsSnapshot;
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
    dependencySnapshotCache?: CompilerDependencySnapshotCache;
  };

export type CompileProgramSuccessResult = {
  success: true;
  graph: ModuleGraph;
  semantics?: Map<string, SemanticsPipelineResult>;
  wasm?: Uint8Array;
};

export type CompileProgramFailureResult = {
  success: false;
  diagnostics: Diagnostic[];
};

export type CompileProgramResult =
  | CompileProgramSuccessResult
  | CompileProgramFailureResult;

export const analyzeModules = ({
  graph,
  includeTests,
  testScope,
  recoverFromTypingErrors,
  captureDependencySnapshot,
  previousSemantics,
  changedModuleIds,
  typingState,
  isCancelled,
}: AnalyzeModulesOptions): AnalyzeModulesResult => {
  const {
    semantics,
    diagnostics,
    recomputedModuleIds,
    dependencySnapshot,
  } = analyzeModuleSemantics({
    graph,
    includeTests,
    recoverFromTypingErrors,
    captureDependencySnapshot,
    previousSemantics,
    changedModuleIds,
    typingState,
    isCancelled,
  });

  diagnostics.push(...enforcePublicApiMethodEffectAnnotations({ semantics }));

  const tests = includeTests
    ? collectTests({ graph, semantics, scope: testScope ?? "all" })
    : [];
  return {
    semantics,
    diagnostics,
    tests,
    recomputedModuleIds,
    dependencySnapshot,
  };
};

const enforcePublicApiMethodEffectAnnotations = ({
  semantics,
}: {
  semantics: Map<string, SemanticsPipelineResult>;
}): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  const importTargetsByModule = new Map<
    string,
    ReadonlyMap<SymbolId, { moduleId: string; symbol: SymbolId }>
  >();

  const importTargetsFor = (
    moduleId: string,
  ): ReadonlyMap<SymbolId, { moduleId: string; symbol: SymbolId }> => {
    const cached = importTargetsByModule.get(moduleId);
    if (cached) return cached;
    const mod = semantics.get(moduleId);
    if (!mod) return new Map();
    const mapped = new Map<SymbolId, { moduleId: string; symbol: SymbolId }>();
    mod.binding.imports.forEach((entry) => {
      if (!entry.target) return;
      mapped.set(entry.local, entry.target);
    });
    importTargetsByModule.set(moduleId, mapped);
    return mapped;
  };

  const resolveImportedTarget = ({
    moduleId,
    symbol,
  }: {
    moduleId: string;
    symbol: SymbolId;
  }): { moduleId: string; symbol: SymbolId } => {
    const seen = new Set<string>();
    let currentModuleId = moduleId;
    let currentSymbol = symbol;

    while (true) {
      const key = `${currentModuleId}:${currentSymbol}`;
      if (seen.has(key)) return { moduleId: currentModuleId, symbol: currentSymbol };
      seen.add(key);

      const next = importTargetsFor(currentModuleId).get(currentSymbol);
      if (!next) return { moduleId: currentModuleId, symbol: currentSymbol };
      currentModuleId = next.moduleId;
      currentSymbol = next.symbol;
    }
  };

  const packageRoots = Array.from(semantics.entries()).filter(
    ([, entry]) => entry.binding.isPackageRoot,
  );

  packageRoots.forEach(([rootModuleId, root]) => {
    const rootSymbolTable = getSymbolTable(root);
    const packageId = root.binding.packageId;

    const exportedObjectTargets = new Set<string>();
    root.hir.module.exports.forEach((entry) => {
      if (entry.visibility.level !== "public") return;
      if (rootSymbolTable.getSymbol(entry.symbol).kind !== "type") return;
      const resolved = resolveImportedTarget({
        moduleId: rootModuleId,
        symbol: entry.symbol,
      });
      const targetModule = semantics.get(resolved.moduleId);
      if (!targetModule) return;
      if (targetModule.binding.packageId !== packageId) return;
      exportedObjectTargets.add(`${resolved.moduleId}:${resolved.symbol}`);
    });

    if (exportedObjectTargets.size === 0) return;

    const seen = new Set<string>();

    semantics.forEach((mod, moduleId) => {
      if (mod.binding.packageId !== packageId) return;

      const symbolTable = getSymbolTable(mod);

      const functionSpanFor = (symbol: SymbolId): SourceSpan => {
        for (const item of mod.hir.items.values()) {
          if (item.kind !== "function") continue;
          if (item.symbol === symbol) return item.span;
        }
        return mod.hir.module.span;
      };

      const effectInfoFor = (
        effectRow: number,
      ): { isPure: boolean; isPolymorphic: boolean; effectsText: string } => {
        try {
          const row = mod.typing.effects.getRow(effectRow);
          const isPure = mod.typing.effects.isEmpty(effectRow);
          return {
            isPure,
            isPolymorphic:
              !isPure && row.operations.length === 0 && Boolean(row.tailVar),
            effectsText: formatEffectRow(effectRow, mod.typing.effects),
          };
        } catch {
          return {
            isPure: false,
            isPolymorphic: false,
            effectsText: "unknown effects",
          };
        }
      };

      mod.typing.memberMetadata.forEach((metadata, symbol) => {
        if (!metadata.visibility?.api) return;
        if (typeof metadata.owner !== "number") return;

        const resolvedOwner = resolveImportedTarget({
          moduleId,
          symbol: metadata.owner,
        });
        if (!exportedObjectTargets.has(`${resolvedOwner.moduleId}:${resolvedOwner.symbol}`)) {
          return;
        }

        const signature = mod.typing.functions.getSignature(symbol);
        if (!signature) return;

        const { isPure, isPolymorphic, effectsText } = effectInfoFor(signature.effectRow);
        if (signature.annotatedEffects || isPure || isPolymorphic) return;

        const seenKey = `${moduleId}:${symbol}`;
        if (seen.has(seenKey)) return;
        seen.add(seenKey);

        const ownerName = symbolTable.getSymbol(metadata.owner).name;
        const memberName = symbolTable.getSymbol(symbol).name;

        diagnostics.push(
          diagnosticFromCode({
            code: "TY0016",
            params: {
              kind: "pkg-effect-annotation",
              functionName: `${ownerName}.${memberName}`,
              effects: effectsText,
            },
            span: functionSpanFor(symbol),
          }),
        );
      });
    });
  });

  return diagnostics;
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
  const lowerStartedAt = startCompilerPerfPhase();
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  markCompilerPerfPhaseDuration("lowerProgram", lowerStartedAt);
  recordCompilerPerfDuration({
    name: "emit.lower_program.ms",
    startedAt: lowerStartedAt,
  });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const codegenLoadStartedAt = startCompilerPerfPhase();
  const codegen = await lazyCodegen();
  markCompilerPerfPhaseDuration("loadCodegen", codegenLoadStartedAt);
  const monomorphizeStartedAt = startCompilerPerfPhase();
  recordCompilerPerfDuration({
    name: "emit.load_codegen.ms",
    startedAt: codegenLoadStartedAt,
  });

  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  markCompilerPerfPhaseDuration("monomorphizeProgram", monomorphizeStartedAt);
  const viewStartedAt = startCompilerPerfPhase();
  recordCompilerPerfDuration({
    name: "emit.link_semantics.ms",
    startedAt: monomorphizeStartedAt,
  });

  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  markCompilerPerfPhaseDuration("buildProgramCodegenView", viewStartedAt);
  const optimizeStartedAt = startCompilerPerfPhase();
  recordCompilerPerfDuration({
    name: "emit.build_codegen_view.ms",
    startedAt: viewStartedAt,
  });

  const optimized = codegenOptions?.optimize
    ? optimizeProgram({
        program,
        modules,
        entryModuleId: targetModuleId,
        options: codegenOptions,
      })
    : undefined;
  markCompilerPerfPhaseDuration("optimizeProgram", optimizeStartedAt);
  if (codegenOptions?.optimize) {
    recordCompilerPerfDuration({
      name: "emit.optimize_program.ms",
      startedAt: optimizeStartedAt,
    });
  }

  const codegenStartedAt = startCompilerPerfPhase();
  const result = codegen.codegenProgram({
    program: optimized?.program ?? program,
    entryModuleId: targetModuleId,
    options: codegenOptions,
    optimization: optimized?.facts,
  });
  markCompilerPerfPhaseDuration("codegenProgram", codegenStartedAt);
  const emitStartedAt = startCompilerPerfPhase();
  const wasm = result.wasm ?? emitBinary(result.module);
  markCompilerPerfPhaseDuration("emitBinary", emitStartedAt);
  recordCompilerPerfDuration({
    name: "emit.codegen_program.ms",
    startedAt: codegenStartedAt,
  });

  recordCompilerPerfDuration({
    name: "emit.emit_binary.ms",
    startedAt: emitStartedAt,
  });
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
  const lowerStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  recordCompilerPerfDuration({
    name: "emit_fallback.lower_program.ms",
    startedAt: lowerStartedAt,
  });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const linkStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  recordCompilerPerfDuration({
    name: "emit_fallback.link_semantics.ms",
    startedAt: linkStartedAt,
  });

  const codegenViewStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  recordCompilerPerfDuration({
    name: "emit_fallback.build_codegen_view.ms",
    startedAt: codegenViewStartedAt,
  });

  const optimizeStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const optimized = codegenOptions?.optimize
    ? optimizeProgram({
        program,
        modules,
        entryModuleId: targetModuleId,
        options: codegenOptions,
      })
    : undefined;
  if (codegenOptions?.optimize) {
    recordCompilerPerfDuration({
      name: "emit_fallback.optimize_program.ms",
      startedAt: optimizeStartedAt,
    });
  }

  const loadCodegenStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const codegenImpl = await lazyCodegen();
  recordCompilerPerfDuration({
    name: "emit_fallback.load_codegen.ms",
    startedAt: loadCodegenStartedAt,
  });
  const codegenStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
  const { preferredKind, preferred, fallback } =
    codegenImpl.codegenProgramWithContinuationFallback({
      program: optimized?.program ?? program,
      entryModuleId: targetModuleId,
      options: codegenOptions,
      optimization: optimized?.facts,
    });
  recordCompilerPerfDuration({
    name: "emit_fallback.codegen_program.ms",
    startedAt: codegenStartedAt,
  });

  const toWasmBytes = (result: { module: binaryen.Module }): Uint8Array => {
    const emitBinaryStartedAt = isCompilerPerfEnabled() ? performance.now() : 0;
    const wasm = "wasm" in result && result.wasm instanceof Uint8Array
      ? result.wasm
      : emitBinary(result.module);
    recordCompilerPerfDuration({
      name: "emit_fallback.emit_binary.ms",
      startedAt: emitBinaryStartedAt,
    });
    return wasm;
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

let codegenModulePromise:
  | Promise<typeof import("./codegen/codegen.js")>
  | undefined;

export const preloadCodegen = (): Promise<
  typeof import("./codegen/codegen.js")
> => {
  codegenModulePromise ??= import("./codegen/codegen.js");
  return codegenModulePromise;
};

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

const compileProgramFailure = (
  diagnostics: readonly Diagnostic[]
): CompileProgramFailureResult => ({
  success: false,
  diagnostics: [...diagnostics],
});

const compileProgramSuccess = (
  result: Omit<CompileProgramSuccessResult, "success">
): CompileProgramSuccessResult => ({
  success: true,
  ...result,
});

const diagnosticsFromUnexpectedError = ({
  error,
  moduleId,
}: {
  error: unknown;
  moduleId: string;
}): Diagnostic[] => {
  if (error instanceof DiagnosticError) {
    return [...error.diagnostics];
  }

  return [
    diagnosticFromCode({
      code: "TY9999",
      params: {
        kind: "unexpected-error",
        message: error instanceof Error ? error.message : String(error),
      },
      span: { file: moduleId, start: 0, end: 0 },
    }),
  ];
};

export const compileProgramWithLoader = async (
  options: CompileProgramOptions,
  loadModuleGraph: LoadModuleGraphFn
): Promise<CompileProgramResult> => {
  const codegenLoadPromise = options.skipSemantics
    ? undefined
    : preloadCodegen();
  void codegenLoadPromise?.catch(() => undefined);
  const perfSession = startCompilerPerfSession({
    entryPath: options.entryPath,
  });
  const complete = (
    result: CompileProgramResult,
  ): CompileProgramResult => {
    completeCompilerPerfSession({
      session: perfSession,
      success: result.success,
      diagnostics: result.success ? 0 : result.diagnostics.length,
    });
    return result;
  };

  let graph: ModuleGraph;
  const loadStartedAt = startCompilerPerfPhase();
  try {
    graph = await loadModuleGraph(options);
    markCompilerPerfPhaseDuration("loadModuleGraph", loadStartedAt);
  } catch (error) {
    markCompilerPerfPhaseDuration("loadModuleGraph", loadStartedAt);
    return complete(compileProgramFailure(
      diagnosticsFromUnexpectedError({
        error,
        moduleId: options.entryPath,
      }),
    ));
  }

  if (options.skipSemantics) {
    const diagnostics = [...graph.diagnostics];
    return complete(hasErrorDiagnostics(diagnostics)
      ? compileProgramFailure(diagnostics)
      : compileProgramSuccess({ graph }));
  }

  const analyzeStartedAt = startCompilerPerfPhase();
  const dependencySnapshotReuse = prepareDependencySnapshotReuse({
    cache: options.dependencySnapshotCache,
    graph,
    roots: options.roots,
    includeTests: options.includeTests,
  });
  const {
    semantics,
    diagnostics: semanticDiagnostics,
    dependencySnapshot,
  } = analyzeModules({
    graph,
    includeTests: options.includeTests,
    captureDependencySnapshot: Boolean(dependencySnapshotReuse.key),
    previousSemantics: dependencySnapshotReuse.previousSemantics,
    typingState: dependencySnapshotReuse.typingState,
  });
  markCompilerPerfPhaseDuration("analyzeModules", analyzeStartedAt);
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (hasErrorDiagnostics(diagnostics)) {
    return complete(compileProgramFailure(diagnostics));
  }

  commitDependencySnapshot({
    prepared: dependencySnapshotReuse,
    dependencySnapshot,
  });

  const shouldLinkSemantics = options.linkSemantics !== false;

  const emitStartedAt = startCompilerPerfPhase();
  try {
    const wasmResult = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
      linkSemantics: shouldLinkSemantics,
    });
    markCompilerPerfPhaseDuration("emitProgram", emitStartedAt);

    diagnostics.push(...wasmResult.diagnostics);

    if (hasErrorDiagnostics(diagnostics)) {
      return complete(compileProgramFailure(diagnostics));
    }

    return complete(compileProgramSuccess({
      graph,
      semantics,
      wasm: wasmResult.wasm,
    }));
  } catch (error) {
    markCompilerPerfPhaseDuration("emitProgram", emitStartedAt);
    return complete(compileProgramFailure([
      ...diagnostics,
      codegenErrorToDiagnostic(error, {
        moduleId: options.entryModuleId ?? graph.entry,
      }),
    ]));
  }
};

const moduleIdForPath = (path: ModulePath): string => modulePathToString(path);

const lazyCodegen = async () =>
  preloadCodegen();

const emitBinary = (module: binaryen.Module): Uint8Array => {
  const binary = module.emitBinary();
  return binary instanceof Uint8Array
    ? binary
    : (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (binary as { binary?: Uint8Array }).binary ??
        new Uint8Array();
};
