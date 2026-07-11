import { codegenErrorToDiagnostic } from "@voyd-lang/compiler/codegen/diagnostics.js";
import type { Diagnostic } from "@voyd-lang/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd-lang/compiler/diagnostics/index.js";
import {
  commitDependencySnapshot,
  createCompilerDependencySnapshotCache,
  prepareDependencySnapshotReuse,
  type CompilerDependencySnapshotCache,
} from "@voyd-lang/compiler/modules/dependency-snapshot-cache.js";
import type { ModuleHost, ModuleRoots } from "@voyd-lang/compiler/modules/types.js";
import {
  analyzeModules,
  emitProgram,
  preloadCodegen,
  type LoadModuleGraphFn,
  type TestScope,
} from "@voyd-lang/compiler/pipeline-shared.js";
import {
  addCompilerPerfPhaseDuration,
  completeCompilerPerfSession,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
  startCompilerPerfSession,
} from "@voyd-lang/compiler/perf.js";
import type { BoundaryExportsOption } from "@voyd-lang/compiler/codegen/context.js";
import type { OptimizationLevel } from "@voyd-lang/compiler/optimization-policy.js";
import type { TestCase } from "./types.js";
import { diagnosticsFromUnknownError } from "./diagnostics.js";

export type CompileArtifactsSuccess = {
  success: true;
  wasm: Uint8Array;
  wasmText?: string;
  tests?: readonly TestCase[];
  testsWasm?: Uint8Array;
};

export type CompileArtifactsFailure = {
  success: false;
  diagnostics: Diagnostic[];
};

export type CompileArtifacts = CompileArtifactsSuccess | CompileArtifactsFailure;

export type CompilerReuseCache = CompilerDependencySnapshotCache;

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

export const createCompilerReuseCache = createCompilerDependencySnapshotCache;

export const compileWithLoader = async ({
  entryPath,
  roots,
  host,
  includeTests,
  testsOnly,
  runtimeDiagnostics,
  optimizationLevel,
  optimize,
  loadModuleGraph,
  testScope,
  boundaryExports,
  externalDeclarations,
  cache,
  setupPhasesMs,
  finalizeSuccess,
}: {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
  testsOnly?: boolean;
  runtimeDiagnostics?: boolean;
  optimizationLevel?: OptimizationLevel;
  optimize?: boolean;
  loadModuleGraph: LoadModuleGraphFn;
  testScope?: TestScope;
  boundaryExports?: BoundaryExportsOption;
  externalDeclarations?: boolean;
  cache?: CompilerReuseCache;
  setupPhasesMs?: Readonly<Record<string, number>>;
  finalizeSuccess?: (
    result: CompileArtifactsSuccess,
  ) => CompileArtifactsSuccess | Promise<CompileArtifactsSuccess>;
}): Promise<CompileArtifacts> => {
  const perf = createCompilePerfScope({ entryPath, setupPhasesMs });

  try {
    const shouldIncludeTests = includeTests || testsOnly;
    const codegenLoadPromise = preloadCodegen();
    void codegenLoadPromise.catch(() => undefined);
    const finalize = async (
      result: CompileArtifactsSuccess,
    ): Promise<CompileArtifactsSuccess> => {
      if (!finalizeSuccess) {
        return result;
      }
      const finalizeStartedAt = perf.start();
      try {
        return await finalizeSuccess(result);
      } finally {
        perf.mark("sdk.finalizeCompile", finalizeStartedAt);
      }
    };

    let graph: Awaited<ReturnType<LoadModuleGraphFn>>;
    const loadStartedAt = perf.start();
    try {
      graph = await loadModuleGraph({
        entryPath,
        roots,
        host,
        includeTests: shouldIncludeTests,
      });
      perf.mark("loadModuleGraph", loadStartedAt);
    } catch (error) {
      perf.mark("loadModuleGraph", loadStartedAt);
      return perf.complete({
        success: false,
        diagnostics: diagnosticsFromUnknownError({
          error,
          fallbackFile: entryPath,
        }),
      });
    }

    const scopedTestScope = testScope ?? "all";
    const runtimeDiagnosticsCodegenOption =
      typeof runtimeDiagnostics === "boolean"
        ? { runtimeDiagnostics, emitEffectHelpers: true }
        : { emitEffectHelpers: true };
    const optimizationCodegenOption = {
      ...(optimizationLevel ? { optimizationLevel } : {}),
      ...(typeof optimize === "boolean" ? { optimize } : {}),
    };
    const codegenOption = {
      ...optimizationCodegenOption,
      ...runtimeDiagnosticsCodegenOption,
      boundaryExports: boundaryExports ?? "auto",
      externalDeclarations: externalDeclarations ?? false,
    } as const;
    const testCodegenOption = {
      ...optimizationCodegenOption,
      ...runtimeDiagnosticsCodegenOption,
      boundaryExports: false,
      externalDeclarations: false,
    } as const;

    const dependencySnapshotReuse = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots,
      includeTests: shouldIncludeTests,
    });

    const analyzeStartedAt = perf.start();
    const {
      semantics,
      diagnostics: semanticDiagnostics,
      tests,
      dependencySnapshot,
    } = analyzeModules({
      graph,
      includeTests: shouldIncludeTests,
      testScope: scopedTestScope,
      captureDependencySnapshot: Boolean(dependencySnapshotReuse.key),
      previousSemantics: dependencySnapshotReuse.previousSemantics,
      typingState: dependencySnapshotReuse.typingState,
    });
    perf.mark("analyzeModules", analyzeStartedAt);
    const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
    const testCases = shouldIncludeTests ? tests : undefined;

    if (hasErrorDiagnostics(diagnostics)) {
      return perf.complete({
        success: false,
        diagnostics,
      });
    }

    commitDependencySnapshot({
      prepared: dependencySnapshotReuse,
      dependencySnapshot,
    });

    try {
      if (testsOnly) {
        const emitStartedAt = perf.start();
        const testResult = await emitProgram({
          graph,
          semantics,
          codegenOptions: {
            testMode: true,
            testScope: scopedTestScope,
            ...testCodegenOption,
          },
        });
        perf.mark("emitProgram.tests", emitStartedAt);
        const allDiagnostics = [...diagnostics, ...testResult.diagnostics];
        if (hasErrorDiagnostics(allDiagnostics)) {
          return perf.complete({ success: false, diagnostics: allDiagnostics });
        }

        return perf.complete(await finalize({
          success: true,
          wasm: testResult.wasm,
          tests: testCases,
          testsWasm: testResult.wasm,
        }));
      }

      const emitStartedAt = perf.start();
      const wasmResult = await emitProgram({
        graph,
        semantics,
        codegenOptions: codegenOption,
      });
      perf.mark("emitProgram", emitStartedAt);
      const baseDiagnostics = [...diagnostics, ...wasmResult.diagnostics];
      if (hasErrorDiagnostics(baseDiagnostics)) {
        return perf.complete({ success: false, diagnostics: baseDiagnostics });
      }

      let testsWasm: Uint8Array | undefined;

      if (shouldIncludeTests && tests.length > 0) {
        const testEmitStartedAt = perf.start();
        const testResult = await emitProgram({
          graph,
          semantics,
          codegenOptions: {
            testMode: true,
            testScope: scopedTestScope,
            ...testCodegenOption,
          },
        });
        perf.mark("emitProgram.tests", testEmitStartedAt);
        const allDiagnostics = [...baseDiagnostics, ...testResult.diagnostics];
        if (hasErrorDiagnostics(allDiagnostics)) {
          return perf.complete({ success: false, diagnostics: allDiagnostics });
        }
        testsWasm = testResult.wasm;
      }

      return perf.complete(await finalize({
        success: true,
        wasm: wasmResult.wasm,
        tests: testCases,
        testsWasm,
      }));
    } catch (error) {
      const codegenDiagnostics =
        error instanceof DiagnosticError
          ? error.diagnostics
          : [
              codegenErrorToDiagnostic(error, {
                moduleId: graph.entry ?? entryPath,
              }),
            ];
      return perf.complete({
        success: false,
        diagnostics: [...diagnostics, ...codegenDiagnostics],
      });
    }
  } catch (error) {
    return perf.complete({
      success: false,
      diagnostics: diagnosticsFromUnknownError({
        error,
        fallbackFile: entryPath,
      }),
    });
  }
};

const createCompilePerfScope = ({
  entryPath,
  setupPhasesMs,
}: {
  entryPath: string;
  setupPhasesMs?: Readonly<Record<string, number>>;
}) => {
  const session = startCompilerPerfSession({ entryPath });
  Object.entries(setupPhasesMs ?? {}).forEach(([phase, durationMs]) => {
    addCompilerPerfPhaseDuration(phase, durationMs);
  });

  const start = startCompilerPerfPhase;
  const mark = markCompilerPerfPhaseDuration;
  const complete = <T extends CompileArtifacts>(result: T): T => {
    completeCompilerPerfSession({
      session,
      success: result.success,
      diagnostics: result.success ? 0 : result.diagnostics.length,
      extraTotalMs: setupPhasesMs?.["sdkSetup.total"] ?? 0,
    });
    return result;
  };

  return { start, mark, complete };
};
