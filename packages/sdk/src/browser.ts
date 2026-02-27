import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline-browser.js";
import { compileWithLoader } from "./shared/compile.js";
import { runWithHandlers } from "./shared/host.js";
import { createCompileResult } from "./shared/result.js";
import {
  createUnexpectedDiagnostic,
  diagnosticsFromUnknownError,
} from "./shared/diagnostics.js";
import type { CompileOptions, CompileResult, VoydSdk } from "./shared/types.js";
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

export const createSdk = (): VoydSdk => ({
  compile: compileSdk,
  run: runWithHandlers,
});

const compileSdk = async (options: CompileOptions): Promise<CompileResult> => {
  const fallbackFile = options.entryPath ?? "index.voyd";

  if (options.optimize) {
    return {
      success: false,
      diagnostics: [
        createUnexpectedDiagnostic({
          message: "optimize is not supported in the browser SDK",
          file: fallbackFile,
        }),
      ],
    };
  }

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
    const parsed = await browserParseModule(options.source, {
      entryPath: options.entryPath,
      files: options.files,
      roots: options.roots,
    });
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

    const host = createMemoryModuleHost({ files: parsed.files });
    const result = await compileWithLoader({
      entryPath: parsed.entryPath,
      roots,
      host,
      includeTests: options.includeTests,
      testsOnly: options.testsOnly,
      testScope: options.testScope ?? "entry",
      loadModuleGraph,
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
export { parse } from "@voyd/compiler/parser/parser.js";
export * from "@voyd/lib/wasm.js";
export type {
  CompileOptions,
  CompileResult,
  EffectsInfo,
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  ModuleRoots,
  RunOptions,
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
