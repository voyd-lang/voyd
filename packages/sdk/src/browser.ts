import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline-browser.js";
import { compileWithLoader } from "./shared/compile.js";
import { runWithHandlers } from "./shared/host.js";
import { createCompileResult } from "./shared/result.js";
import type { CompileOptions, CompileResult, VoydSdk } from "./shared/types.js";
import {
  browserParseModule,
  compile,
  compileParsedModule,
  type BrowserCompileOptions,
  type ParsedModule,
} from "./compiler-browser.js";

export const createSdk = (): VoydSdk => ({
  compile: compileSdk,
  run: runWithHandlers,
});

const compileSdk = async (options: CompileOptions): Promise<CompileResult> => {
  if (options.optimize) {
    throw new Error("optimize is not supported in the browser SDK");
  }

  if (options.emitWasmText) {
    throw new Error("emitWasmText is not supported in the browser SDK");
  }

  if (options.source === undefined) {
    throw new Error("compile requires source in browser builds");
  }

  const parsed = await browserParseModule(options.source, {
    entryPath: options.entryPath,
    files: options.files,
    roots: options.roots,
  });
  const roots = parsed.roots ?? options.roots;
  if (!roots) {
    throw new Error("Unable to determine module roots for browser compile");
  }

  const host = createMemoryModuleHost({ files: parsed.files });
  const result = await compileWithLoader({
    entryPath: parsed.entryPath,
    roots,
    host,
    includeTests: options.includeTests,
    testsOnly: options.testsOnly,
    testScope: "entry",
    loadModuleGraph,
  });
  return createCompileResult(result);
};

export {
  browserParseModule,
  compile,
  compileParsedModule,
  type BrowserCompileOptions,
  type ParsedModule,
};
export { parse } from "@voyd/compiler/parser/parser.js";
export * from "@voyd/lib/wasm.js";
export type {
  CompileOptions,
  CompileResult,
  EffectHandler,
  ModuleRoots,
  RunOptions,
  TestCase,
  TestCollection,
  TestEvent,
  TestInfo,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydSdk,
} from "./shared/types.js";
