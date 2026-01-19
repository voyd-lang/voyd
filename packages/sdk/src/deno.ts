import type { CompileResult, RunOptions, VoydSdk } from "./shared/types.js";

export const createSdk = (): VoydSdk => ({
  compile: async (): Promise<CompileResult> => {
    throw new Error("Deno SDK is not implemented yet");
  },
  createHost: async () => {
    throw new Error("Deno SDK is not implemented yet");
  },
  run: async <T = unknown>(_options: RunOptions): Promise<T> => {
    throw new Error("Deno SDK is not implemented yet");
  },
});

export type {
  CompileOptions,
  CompileResult,
  EffectHandler,
  HostInitOptions,
  ModuleRoots,
  RunOptions,
  TestCase,
  TestCollection,
  TestEvent,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydHost,
  VoydSdk,
} from "./shared/types.js";
