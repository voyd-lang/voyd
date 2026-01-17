import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline-browser.js";
import { compileWithLoader } from "./shared/compile.js";
import { createHost, runWithHandlers } from "./shared/host.js";
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
  createHost,
  run: runWithHandlers,
});

const compileSdk = async (options: CompileOptions): Promise<CompileResult> => {
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
  return compileWithLoader({
    entryPath: parsed.entryPath,
    roots,
    host,
    includeTests: options.includeTests,
    loadModuleGraph,
  });
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
  HostInitOptions,
  ModuleRoots,
  RunOptions,
  VoydHost,
  VoydSdk,
} from "./shared/types.js";
