import type {
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
} from "../../protocol/types.js";
import type { HostRuntimeKind } from "../../runtime/environment.js";

export const FS_EFFECT_ID = "std::fs::Fs";
export const TIME_EFFECT_ID = "std::time::Time";
export const ENV_EFFECT_ID = "std::env::Env";
export const RANDOM_EFFECT_ID = "std::random::Random";
export const LOG_EFFECT_ID = "std::log::Log";
export const FETCH_EFFECT_ID = "std::fetch::Fetch";
export const INPUT_EFFECT_ID = "std::input::Input";
export const OUTPUT_EFFECT_ID = "std::output::Output";

export type EffectOp = HostProtocolTable["ops"][number];

export type DefaultAdapterHost = {
  table: HostProtocolTable;
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: SignatureHash,
    handler: EffectHandler
  ) => void;
};

export type DefaultAdapterFetchHeader = {
  name: string;
  value: string;
};

export type DefaultAdapterFetchRequest = {
  method: string;
  url: string;
  headers: DefaultAdapterFetchHeader[];
  body?: string;
  timeoutMillis?: number;
};

export type DefaultAdapterFetchResponse = {
  status: number;
  statusText: string;
  headers: DefaultAdapterFetchHeader[];
  body: string;
};

export type DefaultAdapterOutputTarget = "stdout" | "stderr";

export type DefaultAdapterOutputWrite = {
  target: DefaultAdapterOutputTarget;
  value: string;
};

export type DefaultAdapterOutputWriteBytes = {
  target: DefaultAdapterOutputTarget;
  bytes: Uint8Array;
};

export type DefaultAdapterOutputFlush = {
  target: DefaultAdapterOutputTarget;
};

export type DefaultAdapterRuntimeHooks = {
  monotonicNowMillis?: () => bigint;
  systemNowMillis?: () => bigint;
  sleepMillis?: (ms: number) => Promise<void>;
  randomBytes?: (length: number) => Uint8Array;
  fetchRequest?: (
    request: DefaultAdapterFetchRequest
  ) => Promise<DefaultAdapterFetchResponse>;
  readLine?: (prompt: string | null) => Promise<string | null>;
  readBytes?: (maxBytes: number) => Promise<Uint8Array | null>;
  isInputTty?: () => boolean;
  write?: (output: DefaultAdapterOutputWrite) => Promise<void>;
  writeBytes?: (output: DefaultAdapterOutputWriteBytes) => Promise<void>;
  flush?: (output: DefaultAdapterOutputFlush) => Promise<void>;
  isOutputTty?: (target: DefaultAdapterOutputTarget) => boolean;
};

export type DefaultAdapterOptions = {
  runtime?: HostRuntimeKind | "auto";
  onDiagnostic?: (message: string) => void;
  logWriter?: Pick<Console, "trace" | "debug" | "info" | "warn" | "error">;
  runtimeHooks?: DefaultAdapterRuntimeHooks;
  effectBufferSize?: number;
};

export type DefaultAdapterCapability = {
  capability:
    | "fs"
    | "timer"
    | "env"
    | "random"
    | "log"
    | "fetch"
    | "input"
    | "output";
  effectId: string;
  registeredOps: number;
  supported: boolean;
  reason?: string;
};

export type DefaultAdapterRegistration = {
  runtime: HostRuntimeKind;
  registeredOps: number;
  capabilities: DefaultAdapterCapability[];
};

export type CapabilityContext = {
  host: DefaultAdapterHost;
  runtime: HostRuntimeKind;
  diagnostics: string[];
  logWriter: Pick<Console, "trace" | "debug" | "info" | "warn" | "error">;
  runtimeHooks: DefaultAdapterRuntimeHooks;
  effectBufferSize: number;
};

export type CapabilityDefinition = {
  capability: DefaultAdapterCapability["capability"];
  effectId: string;
  register: (context: CapabilityContext) => Promise<number>;
};

export type NodeFsPromises = {
  readFile: (path: string) => Promise<Uint8Array>;
  readFileSync?: never;
  readTextFile?: never;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  access: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
};

export type NodeReadlinePromises = {
  createInterface: (options: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    terminal?: boolean;
  }) => {
    question: (query: string) => Promise<string>;
    close: () => void;
  };
};

export type NodeReadableWithRead = NodeJS.ReadableStream & {
  read: (size?: number) => unknown;
  isTTY?: boolean;
};

export type NodeWritableWithWrite = NodeJS.WritableStream & {
  write: (
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void
  ) => boolean;
  isTTY?: boolean;
  writableNeedDrain?: boolean;
};
