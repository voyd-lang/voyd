import type {
  CompileResult,
  RunOptions,
  ServeWebAppOptions,
  ServeWebAppResult,
  VoydSdk,
} from "./shared/types.js";

export const createSdk = (): VoydSdk => ({
  compile: async (): Promise<CompileResult> => {
    throw new Error("Deno SDK is not implemented yet");
  },
  run: async <T = unknown>(_options: RunOptions): Promise<T> => {
    throw new Error("Deno SDK is not implemented yet");
  },
  serveWebApp: async (_options: ServeWebAppOptions): Promise<ServeWebAppResult> => {
    throw new Error("Deno SDK is not implemented yet");
  },
});

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
  VoydSdk,
} from "./shared/types.js";
