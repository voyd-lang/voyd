import { codegenErrorToDiagnostic } from "@voyd-lang/compiler/codegen/diagnostics.js";
import type { Diagnostic } from "@voyd-lang/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd-lang/compiler/diagnostics/index.js";
import type { ModuleHost, ModuleRoots } from "@voyd-lang/compiler/modules/types.js";
import {
  analyzeModules,
  emitProgram,
  preloadCodegen,
  type LoadModuleGraphFn,
  type TestScope,
} from "@voyd-lang/compiler/pipeline-shared.js";
import {
  completeCompilerPerfSession,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
  startCompilerPerfSession,
} from "@voyd-lang/compiler/perf.js";
import type { BoundaryExportsOption } from "@voyd-lang/compiler/codegen/context.js";
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

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

export const compileWithLoader = async ({
  entryPath,
  roots,
  host,
  includeTests,
  testsOnly,
  runtimeDiagnostics,
  optimize,
  loadModuleGraph,
  testScope,
  boundaryExports,
  finalizeSuccess,
}: {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
  testsOnly?: boolean;
  runtimeDiagnostics?: boolean;
  optimize?: boolean;
  loadModuleGraph: LoadModuleGraphFn;
  testScope?: TestScope;
  boundaryExports?: BoundaryExportsOption;
  finalizeSuccess?: (
    result: CompileArtifactsSuccess,
  ) => CompileArtifactsSuccess | Promise<CompileArtifactsSuccess>;
}): Promise<CompileArtifacts> => {
  const shouldIncludeTests = includeTests || testsOnly;
  const codegenLoadPromise = preloadCodegen();
  void codegenLoadPromise.catch(() => undefined);
  const perfSession = startCompilerPerfSession({ entryPath });
  const complete = (result: CompileArtifacts): CompileArtifacts => {
    completeCompilerPerfSession({
      session: perfSession,
      success: result.success,
      diagnostics: result.success ? 0 : result.diagnostics.length,
    });
    return result;
  };
  const finalize = async (
    result: CompileArtifactsSuccess,
  ): Promise<CompileArtifactsSuccess> => {
    if (!finalizeSuccess) {
      return result;
    }
    const finalizeStartedAt = startCompilerPerfPhase();
    try {
      return await finalizeSuccess(result);
    } finally {
      markCompilerPerfPhaseDuration("sdk.finalizeCompile", finalizeStartedAt);
    }
  };
  const emitProgramWithPerf = async (
    phase: string,
    options: Parameters<typeof emitProgram>[0],
  ): Promise<Awaited<ReturnType<typeof emitProgram>>> => {
    const startedAt = startCompilerPerfPhase();
    try {
      return await emitProgram(options);
    } finally {
      markCompilerPerfPhaseDuration(phase, startedAt);
    }
  };
  let graph: Awaited<ReturnType<LoadModuleGraphFn>>;
  const loadStartedAt = startCompilerPerfPhase();
  try {
    graph = await loadModuleGraph({
      entryPath,
      roots,
      host,
      includeTests: shouldIncludeTests,
    });
    markCompilerPerfPhaseDuration("loadModuleGraph", loadStartedAt);
  } catch (error) {
    markCompilerPerfPhaseDuration("loadModuleGraph", loadStartedAt);
    return complete({
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
  const optimizationCodegenOption =
    typeof optimize === "boolean" ? { optimize } : {};
  const codegenOption = {
    ...optimizationCodegenOption,
    ...runtimeDiagnosticsCodegenOption,
    boundaryExports: boundaryExports ?? "auto",
  } as const;
  const testCodegenOption = {
    ...optimizationCodegenOption,
    ...runtimeDiagnosticsCodegenOption,
    boundaryExports: false,
  } as const;
  const analyzeStartedAt = startCompilerPerfPhase();
  const { semantics, diagnostics: semanticDiagnostics, tests } = analyzeModules({
    graph,
    includeTests: shouldIncludeTests,
    testScope: scopedTestScope,
  });
  markCompilerPerfPhaseDuration("analyzeModules", analyzeStartedAt);
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
  const testCases = shouldIncludeTests ? tests : undefined;

  if (hasErrorDiagnostics(diagnostics)) {
    return complete({
      success: false,
      diagnostics,
    });
  }

  try {
    if (testsOnly) {
      const testResult = await emitProgramWithPerf("emitProgram", {
        graph,
        semantics,
        codegenOptions: {
          testMode: true,
          testScope: scopedTestScope,
          ...testCodegenOption,
        },
      });
      const allDiagnostics = [...diagnostics, ...testResult.diagnostics];
      if (hasErrorDiagnostics(allDiagnostics)) {
        return complete({ success: false, diagnostics: allDiagnostics });
      }

      return complete(await finalize({
        success: true,
        wasm: testResult.wasm,
        tests: testCases,
        testsWasm: testResult.wasm,
      }));
    }

    const wasmResult = await emitProgramWithPerf("emitProgram", {
      graph,
      semantics,
      codegenOptions: codegenOption,
    });
    const baseDiagnostics = [...diagnostics, ...wasmResult.diagnostics];
    if (hasErrorDiagnostics(baseDiagnostics)) {
      return complete({ success: false, diagnostics: baseDiagnostics });
    }

    let testsWasm: Uint8Array | undefined;

    if (shouldIncludeTests && tests.length > 0) {
      const testResult = await emitProgramWithPerf("emitProgram.tests", {
        graph,
        semantics,
        codegenOptions: {
          testMode: true,
          testScope: scopedTestScope,
          ...testCodegenOption,
        },
      });
      const allDiagnostics = [...baseDiagnostics, ...testResult.diagnostics];
      if (hasErrorDiagnostics(allDiagnostics)) {
        return complete({ success: false, diagnostics: allDiagnostics });
      }
      testsWasm = testResult.wasm;
    }

    return complete(await finalize({
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
    return complete({
      success: false,
      diagnostics: [...diagnostics, ...codegenDiagnostics],
    });
  }
};
