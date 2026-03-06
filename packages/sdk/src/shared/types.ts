import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { TestCase as CompilerTestCase } from "@voyd/compiler/pipeline-shared.js";
import type {
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
  VoydRuntimeDiagnostics,
  VoydRuntimeError,
} from "@voyd/js-host";

export type {
  Diagnostic,
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  ModuleRoots,
  SignatureHash,
  VoydRuntimeDiagnostics,
  VoydRuntimeError,
};

export type TestCase = CompilerTestCase;

export type ExportAbiEntry = {
  name: string;
  abi: "direct" | "serialized";
  formatId?: string;
};

export type ExportAbiMetadata = {
  version: number;
  exports: ExportAbiEntry[];
};

export type CompileOptions = {
  entryPath?: string;
  source?: string;
  files?: Record<string, string>;
  roots?: ModuleRoots;
  includeTests?: boolean;
  /** Emit a test-only wasm module. */
  testsOnly?: boolean;
  /** Control which modules contribute test cases. */
  testScope?: "all" | "entry";
  optimize?: boolean;
  /**
   * Emit runtime trap-to-source metadata.
   * Defaults to true for non-optimized builds and false for optimized builds.
   */
  runtimeDiagnostics?: boolean;
  emitWasmText?: boolean;
};

export type CompileSuccessResult = {
  success: true;
  wasm: Uint8Array;
  wasmText?: string;
  effects: EffectsInfo;
  tests?: TestCollection;
  run: <T = unknown>(opts: Omit<RunOptions, "wasm">) => Promise<T>;
};

export type CompileFailureResult = {
  success: false;
  diagnostics: Diagnostic[];
};

export type CompileResult = CompileSuccessResult | CompileFailureResult;

export type EffectsInfo = {
  table: HostProtocolTable;
  findUniqueOpByLabelSuffix: (
    labelSuffix: string
  ) => HostProtocolTable["ops"][number];
  signatureHashFor: (opts: {
    effectId: string;
    opName: string;
  }) => SignatureHash;
  handlerKeyFor: (opts: {
    effectId: string;
    opName: string;
    signatureHash?: SignatureHash;
  }) => string;
};

export type RunOptions = {
  wasm: Uint8Array;
  entryName: string;
  args?: unknown[];
  /** handlers keyed as "effectId::opName" or "effectId::opName::signatureHash", each returning resume(...), tail(...), or end(...) */
  handlers?: Record<string, EffectHandler>;
  /** handlers matched against effect labels by suffix (prefer "::", e.g. "Async::await") */
  handlersByLabelSuffix?: Record<string, EffectHandler>;
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
