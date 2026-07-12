import { createMemoryModuleHost } from "@voyd-lang/compiler/modules/memory-host.js";
import { loadModuleGraph } from "@voyd-lang/compiler/pipeline-browser.js";
import { isCompilerPerfEnabled } from "@voyd-lang/compiler/perf.js";
import {
  compileWithLoader,
  createCompilerReuseCache,
  type CompilerReuseCache,
} from "./shared/compile.js";
import { runWithHandlers } from "./shared/host.js";
import { createCompileResult } from "./shared/result.js";
import {
  createUnexpectedDiagnostic,
  diagnosticsFromUnknownError,
} from "./shared/diagnostics.js";
import type {
  CompileOptions,
  CompileResult,
  ServeWebAppOptions,
  ServeWebAppResult,
  VoydSdk,
} from "./shared/types.js";
import {
  browserParseModule,
  compile,
  compileParsedModule,
  type BrowserCompileFailureResult,
  type BrowserCompileOptions,
  type BrowserCompileResult,
  type BrowserCompileSuccessResult,
  type ParsedModule,
} from "./compiler-browser.js";

export const createSdk = (): VoydSdk => {
  const compilerCache = createCompilerReuseCache();
  return {
    compile: (options) => compileSdk(options, compilerCache),
    run: runWithHandlers,
    serveWebApp,
  };
};

export const serveWebApp = async (
  options: ServeWebAppOptions,
): Promise<ServeWebAppResult> => {
  return {
    success: false,
    diagnostics: [
      createUnexpectedDiagnostic({
        message: "serveWebApp is only supported by the Node SDK",
        file: options.entryPath ?? "index.voyd",
      }),
    ],
  };
};

const compileSdk = async (
  options: CompileOptions,
  compilerCache?: CompilerReuseCache,
): Promise<CompileResult> => {
  const fallbackFile = options.entryPath ?? "index.voyd";

  if (options.emitWasmText) {
    return {
      success: false,
      diagnostics: [
        createUnexpectedDiagnostic({
          message: "emitWasmText is not supported in the browser SDK",
          file: fallbackFile,
        }),
      ],
    };
  }

  if (options.source === undefined) {
    return {
      success: false,
      diagnostics: [
        createUnexpectedDiagnostic({
          message: "compile requires source in browser builds",
          file: fallbackFile,
        }),
      ],
    };
  }

  try {
    const setupPhasesMs: Record<string, number> = {};
    const perfEnabled = isCompilerPerfEnabled();
    const setupStartedAt = perfEnabled ? performance.now() : 0;
    const parseStartedAt = perfEnabled ? performance.now() : 0;
    const parsed = await browserParseModule(options.source, {
      entryPath: options.entryPath,
      files: options.files,
      roots: options.roots,
    });
    recordSetupPhase({
      phasesMs: setupPhasesMs,
      enabled: perfEnabled,
      name: "sdkSetup.browserParseModule",
      startedAt: parseStartedAt,
    });

    const rootStartedAt = perfEnabled ? performance.now() : 0;
    const roots = parsed.roots ?? options.roots;
    if (!roots) {
      return {
        success: false,
        diagnostics: [
          createUnexpectedDiagnostic({
            message: "Unable to determine module roots for browser compile",
            file: parsed.entryPath ?? fallbackFile,
          }),
        ],
      };
    }
    recordSetupPhase({
      phasesMs: setupPhasesMs,
      enabled: perfEnabled,
      name: "sdkSetup.resolveRoots",
      startedAt: rootStartedAt,
    });

    const hostStartedAt = perfEnabled ? performance.now() : 0;
    const host = createMemoryModuleHost({ files: parsed.files });
    recordSetupPhase({
      phasesMs: setupPhasesMs,
      enabled: perfEnabled,
      name: "sdkSetup.createHost",
      startedAt: hostStartedAt,
    });
    recordSetupPhase({
      phasesMs: setupPhasesMs,
      enabled: perfEnabled,
      name: "sdkSetup.total",
      startedAt: setupStartedAt,
    });

    const result = await compileWithLoader({
      entryPath: parsed.entryPath,
      roots,
      host,
      includeTests: options.includeTests,
      testsOnly: options.testsOnly,
      testScope: options.testScope ?? "entry",
      runtimeDiagnostics: options.runtimeDiagnostics,
      optimizationLevel: options.optimizationLevel,
      optimize: options.optimize,
      loadModuleGraph,
      boundaryExports: options.boundaryExports,
      externalDeclarations: options.externalDeclarations,
      cache: compilerCache,
      setupPhasesMs,
    });
    if (!result.success) {
      return result;
    }

    return createCompileResult(result);
  } catch (error) {
    return {
      success: false,
      diagnostics: diagnosticsFromUnknownError({
        error,
        fallbackFile,
      }),
    };
  }
};

const recordSetupPhase = ({
  phasesMs,
  enabled,
  name,
  startedAt,
}: {
  phasesMs: Record<string, number>;
  enabled: boolean;
  name: string;
  startedAt: number;
}): void => {
  if (!enabled) {
    return;
  }
  phasesMs[name] = performance.now() - startedAt;
};

export {
  browserParseModule,
  compile,
  compileParsedModule,
  type BrowserCompileFailureResult,
  type BrowserCompileOptions,
  type BrowserCompileResult,
  type BrowserCompileSuccessResult,
  type ParsedModule,
};
export { parse } from "@voyd-lang/compiler/parser/parser.js";
export * from "@voyd-lang/lib/wasm.js";
export type {
  CompileOptions,
  CompileResult,
  DefaultAdapterOptions,
  EffectsInfo,
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  ModuleRoots,
  OptimizationLevel,
  RunOptions,
  ServeWebAppOptions,
  ServeWebAppResult,
  ServeWebAppSuccessResult,
  SignatureHash,
  TestCase,
  TestCollection,
  TestEvent,
  TestInfo,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydRuntimeDiagnostics,
  VoydRuntimeError,
  VoydSdk,
} from "./shared/types.js";
