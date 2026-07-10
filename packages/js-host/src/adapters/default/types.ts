import type {
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
} from "../../protocol/types.js";
import type { HostRuntimeKind } from "../../runtime/environment.js";

export const FS_EFFECT_ID = "voyd.std.fs";
export const TIME_EFFECT_ID = "voyd.std.time";
export const ENV_EFFECT_ID = "voyd.std.env";
export const RANDOM_EFFECT_ID = "voyd.std.random";
export const LOG_EFFECT_ID = "voyd.std.log";
export const HTTP_CLIENT_EFFECT_ID = "voyd.std.http.client";
export const HTTP_SERVER_EFFECT_ID = "voyd.std.http.server";
export const INPUT_EFFECT_ID = "voyd.std.input";
export const OUTPUT_EFFECT_ID = "voyd.std.output";

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

export type DefaultAdapterHttpHeader = {
  name: string;
  value: string;
};

export type DefaultAdapterHttpRedirectPolicy =
  | { kind: "follow"; maxRedirects: number }
  | { kind: "manual" }
  | { kind: "error" };

export type DefaultAdapterHttpClientRequest = {
  method: string;
  url: string;
  headers: DefaultAdapterHttpHeader[];
  body: Uint8Array;
  timeoutMillis?: number;
  redirectPolicy: DefaultAdapterHttpRedirectPolicy;
};

export type DefaultAdapterHttpClientResponse = {
  status: number;
  reason: string;
  headers: DefaultAdapterHttpHeader[];
  body: Uint8Array;
};

export type DefaultAdapterHttpServerConfig = {
  port: number;
  host?: string;
  maxBodyBytes?: number;
  maxPendingRequests?: number;
  responseTimeoutMillis?: number;
};

export type DefaultAdapterHttpRequest = {
  requestId: number;
  method: string;
  path: string;
  query?: string;
  headers: DefaultAdapterHttpHeader[];
  body: Uint8Array;
};

export type DefaultAdapterHttpResponse = {
  requestId: number;
  status: number;
  reason: string;
  headers: DefaultAdapterHttpHeader[];
  body: Uint8Array;
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
  clearTimer?: (timerId: bigint) => Promise<void> | void;
  randomBytes?: (length: number) => Uint8Array;
  httpClientRequest?: (
    request: DefaultAdapterHttpClientRequest
  ) => Promise<DefaultAdapterHttpClientResponse>;
  httpServerListen?: (
    config: DefaultAdapterHttpServerConfig
  ) => Promise<number>;
  httpServerAccept?: (serverId: number) => Promise<DefaultAdapterHttpRequest>;
  httpServerRespond?: (
    response: DefaultAdapterHttpResponse
  ) => Promise<void>;
  httpServerClose?: (serverId: number) => Promise<void>;
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
    | "http-client"
    | "http-server"
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
  lstat: (path: string) => Promise<{ isDirectory: () => boolean }>;
  rmdir: (path: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
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
