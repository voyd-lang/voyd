import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { TestCase as CompilerTestCase } from "@voyd/compiler/pipeline-shared.js";
import type { EffectHandler } from "@voyd/js-host";

export type { Diagnostic, EffectHandler, ModuleRoots };

export type TestCase = CompilerTestCase;

export type CompileOptions = {
  entryPath?: string;
  source?: string;
  files?: Record<string, string>;
  roots?: ModuleRoots;
  includeTests?: boolean;
  /** Emit a test-only wasm module. */
  testsOnly?: boolean;
  optimize?: boolean;
  emitWasmText?: boolean;
};

export type CompileResult = {
  wasm: Uint8Array;
  wasmText?: string;
  diagnostics: Diagnostic[];
  tests?: TestCollection;
  run: <T = unknown>(opts: Omit<RunOptions, "wasm">) => Promise<T>;
};

export type RunOptions = {
  wasm: Uint8Array;
  entryName: string;
  /** handlers keyed as "effectId:opId:signatureHash" */
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

export type TestCollection = {
  cases: readonly TestCase[];
  hasOnly: boolean;
  run: (opts: TestRunOptions) => Promise<TestRunSummary>;
};

export type TestInfo = {
  id: string;
  moduleId: string;
  modulePath: string;
  description?: string;
  displayName: string;
  modifiers: { skip?: boolean; only?: boolean };
  location?: { filePath: string; startLine: number; startColumn: number };
};

export type TestResult = {
  test: TestCase;
  displayName: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: unknown;
};

export type TestEvent =
  | { type: "discovery:start" }
  | { type: "discovery:complete"; cases: readonly TestCase[] }
  | { type: "test:start"; test: TestCase; displayName: string }
  | { type: "test:log"; test: TestCase; message: string }
  | { type: "test:result"; result: TestResult }
  | { type: "run:complete"; summary: TestRunSummary };

export type TestReporter = {
  onEvent: (event: TestEvent) => void | Promise<void>;
};

export type TestRunOptions = {
  reporter?: TestReporter;
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
  filter?: (info: TestInfo) => boolean;
  isolation?: "per-test" | "shared";
};

export type TestRunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
};

export type VoydSdk = {
  compile: (opts: CompileOptions) => Promise<CompileResult>;
  run: <T = unknown>(opts: RunOptions) => Promise<T>;
};
