import { encode } from "@msgpack/msgpack";
import type { EffectHandler, HostProtocolTable, SignatureHash } from "../protocol/types.js";
import { MIN_EFFECT_BUFFER_SIZE } from "../runtime/constants.js";
import type { HostRuntimeKind } from "../runtime/environment.js";
import { detectHostRuntime } from "../runtime/environment.js";

const FS_EFFECT_ID = "std::fs::Fs";
const TIME_EFFECT_ID = "std::time::Time";
const ENV_EFFECT_ID = "std::env::Env";
const RANDOM_EFFECT_ID = "std::random::Random";
const LOG_EFFECT_ID = "std::log::Log";
const FETCH_EFFECT_ID = "std::fetch::Fetch";
const INPUT_EFFECT_ID = "std::input::Input";
const OUTPUT_EFFECT_ID = "std::output::Output";
const WEB_CRYPTO_MAX_BYTES_PER_CALL = 65_536;
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;
const MAX_TIMER_DELAY_MILLIS_BIGINT = 2_147_483_647n;
const RANDOM_FILL_MAX_REQUEST_BYTES = 1_000_000;
const MSGPACK_FIXARRAY_HEADER_BYTES = 1;
const MSGPACK_ARRAY16_HEADER_BYTES = 3;
const MSGPACK_ARRAY32_HEADER_BYTES = 5;
const MSGPACK_FIXARRAY_MAX_LENGTH = 15;
const MSGPACK_ARRAY16_MAX_LENGTH = 65_535;
const MSGPACK_MAX_BYTES_PER_BYTE_VALUE = 2;
const MSGPACK_OPTS = { useBigInt64: true } as const;

type EffectOp = HostProtocolTable["ops"][number];

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
  capability: "fs" | "timer" | "env" | "random" | "log" | "fetch" | "input" | "output";
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

type CapabilityContext = {
  host: DefaultAdapterHost;
  runtime: HostRuntimeKind;
  diagnostics: string[];
  logWriter: Pick<Console, "trace" | "debug" | "info" | "warn" | "error">;
  runtimeHooks: DefaultAdapterRuntimeHooks;
  effectBufferSize: number;
};

type CapabilityDefinition = {
  capability: DefaultAdapterCapability["capability"];
  effectId: string;
  register: (context: CapabilityContext) => Promise<number>;
};

type NodeFsPromises = {
  readFile: (path: string) => Promise<Uint8Array>;
  readFileSync?: never;
  readTextFile?: never;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  access: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
};

type NodeReadlinePromises = {
  createInterface: (options: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    terminal?: boolean;
  }) => {
    question: (query: string) => Promise<string>;
    close: () => void;
  };
};

type NodeReadableWithRead = NodeJS.ReadableStream & {
  read: (size?: number) => unknown;
  isTTY?: boolean;
};

type NodeWritableWithWrite = NodeJS.WritableStream & {
  write: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => boolean;
  isTTY?: boolean;
  writableNeedDrain?: boolean;
};

const globalRecord = globalThis as Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readField = (value: unknown, key: string): unknown => {
  if (value instanceof Map) {
    return value.get(key);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
};

const toStringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  return undefined;
};

const toNumberOrUndefined = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
};

const toI64 = (value: unknown): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  throw new Error(`expected i64-compatible value, got ${typeof value}`);
};

const normalizeByte = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return ((Math.trunc(value) % 256) + 256) % 256;
  }
  if (typeof value === "bigint") {
    return Number(((value % 256n) + 256n) % 256n);
  }
  return 0;
};

const toUint8Array = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array();
};

const toNonNegativeI64 = (value: unknown): bigint => {
  const normalized = toI64(value);
  return normalized > 0n ? normalized : 0n;
};

const normalizeEffectBufferSize = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return MIN_EFFECT_BUFFER_SIZE;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : MIN_EFFECT_BUFFER_SIZE;
};

const sleepInChunks = async ({
  totalMillis,
  sleep,
}: {
  totalMillis: bigint;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> => {
  if (totalMillis === 0n) {
    await sleep(0);
    return;
  }

  let remaining = totalMillis;
  while (remaining > 0n) {
    const chunkMillis =
      remaining > MAX_TIMER_DELAY_MILLIS_BIGINT
        ? MAX_TIMER_DELAY_MILLIS
        : Number(remaining);
    await sleep(chunkMillis);
    remaining -= BigInt(chunkMillis);
  }
};

const toPath = (value: unknown): string => {
  const path = toStringOrUndefined(value);
  if (!path) {
    throw new Error("expected path payload to be a string");
  }
  return path;
};

const hostOk = (value?: unknown): Record<string, unknown> =>
  value === undefined ? { ok: true } : { ok: true, value };

const hostError = (message: string, code = 1): Record<string, unknown> => ({
  ok: false,
  code,
  message,
});

const payloadFitsEffectTransport = ({
  payload,
  effectBufferSize,
}: {
  payload: Record<string, unknown>;
  effectBufferSize: number;
}): boolean => {
  try {
    const encoded = encode(payload, MSGPACK_OPTS) as Uint8Array;
    return encoded.byteLength <= effectBufferSize;
  } catch {
    return false;
  }
};

const fsTransportOverflowError = ({
  opName,
  effectBufferSize,
}: {
  opName: string;
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default fs adapter ${opName} response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or read a smaller payload.`
  );

const fsSuccessPayload = ({
  opName,
  value,
  effectBufferSize,
}: {
  opName: string;
  value: unknown;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk(value);
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return fsTransportOverflowError({ opName, effectBufferSize });
};

const fetchTransportOverflowError = ({
  effectBufferSize,
}: {
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default fetch adapter request response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or request a smaller payload.`
  );

const fetchSuccessPayload = ({
  response,
  effectBufferSize,
}: {
  response: DefaultAdapterFetchResponse;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk({
    status: response.status,
    status_text: response.statusText,
    headers: response.headers.map((header) => ({
      name: header.name,
      value: header.value,
    })),
    body: response.body,
  });
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return fetchTransportOverflowError({ effectBufferSize });
};

const inputTransportOverflowError = ({
  opName,
  effectBufferSize,
}: {
  opName: string;
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default input adapter ${opName} response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or provide shorter input.`
  );

const inputSuccessPayload = ({
  opName,
  value,
  effectBufferSize,
}: {
  opName: string;
  value: unknown;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk(value);
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return inputTransportOverflowError({ opName, effectBufferSize });
};

const opEntries = ({
  host,
  effectId,
}: {
  host: DefaultAdapterHost;
  effectId: string;
}): EffectOp[] => host.table.ops.filter((entry) => entry.effectId === effectId);

const registerOpHandler = ({
  host,
  effectId,
  opName,
  handler,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  opName: string;
  handler: EffectHandler;
}): number => {
  const matches = host.table.ops.filter(
    (entry) => entry.effectId === effectId && entry.opName === opName
  );
  matches.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, handler);
  });
  return matches.length;
};

const registerOpAliasHandlers = ({
  host,
  effectId,
  opNames,
  handler,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  opNames: readonly string[];
  handler: EffectHandler;
}): number =>
  opNames.reduce(
    (count, opName) =>
      count +
      registerOpHandler({
        host,
        effectId,
        opName,
        handler,
      }),
    0
  );

const registerUnsupportedHandlers = ({
  host,
  effectId,
  capability,
  runtime,
  reason,
  diagnostics,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  capability: DefaultAdapterCapability["capability"];
  runtime: HostRuntimeKind;
  reason: string;
  diagnostics: string[];
}): number => {
  const entries = opEntries({ host, effectId });
  if (entries.length === 0) {
    return 0;
  }
  entries.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, () => {
      throw new Error(
        `Default ${capability} adapter is unavailable on ${runtime} for ${entry.label}. ${reason}. Register a custom handler or avoid using this capability in this runtime.`
      );
    });
  });
  diagnostics.push(
    `Registered unsupported ${capability} stubs for ${effectId} on ${runtime}: ${reason}`
  );
  return entries.length;
};

const registerMissingOpHandlers = ({
  host,
  effectId,
  implementedOps,
  diagnostics,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  implementedOps: Set<string>;
  diagnostics: string[];
}): number => {
  const unknownOps = opEntries({ host, effectId }).filter(
    (entry) => !implementedOps.has(entry.opName)
  );
  unknownOps.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, () => {
      throw new Error(
        `Default adapter for ${effectId} does not implement op ${entry.opName} (${entry.label}). Update the adapter or register a custom handler for this op.`
      );
    });
  });
  if (unknownOps.length > 0) {
    diagnostics.push(
      `Registered ${unknownOps.length} fallback handlers for unknown ${effectId} ops`
    );
  }
  return unknownOps.length;
};

const maybeNodeFs = async (): Promise<NodeFsPromises | undefined> => {
  const nodeFsSpecifier = ["node", "fs/promises"].join(":");
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const mod = await importModule(nodeFsSpecifier);
    return mod as unknown as NodeFsPromises;
  } catch {
    try {
      const mod = await import(/* @vite-ignore */ nodeFsSpecifier);
      return mod as unknown as NodeFsPromises;
    } catch {
      return undefined;
    }
  }
};

const maybeNodeReadlinePromises = async (): Promise<
  NodeReadlinePromises | undefined
> => {
  const nodeReadlineSpecifier = ["node", "readline/promises"].join(":");
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const mod = await importModule(nodeReadlineSpecifier);
    return mod as unknown as NodeReadlinePromises;
  } catch {
    try {
      const mod = await import(/* @vite-ignore */ nodeReadlineSpecifier);
      return mod as unknown as NodeReadlinePromises;
    } catch {
      return undefined;
    }
  }
};

const joinListDirChildPath = ({
  directoryPath,
  childName,
}: {
  directoryPath: string;
  childName: string;
}): string => {
  if (directoryPath === "/") {
    return `/${childName}`;
  }
  const trimmed = directoryPath.replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return `/${childName}`;
  }
  return `${trimmed}/${childName}`;
};

const fsCapabilityDefinition: CapabilityDefinition = {
  capability: "fs",
  effectId: FS_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, effectBufferSize }) => {
    const entries = opEntries({ host, effectId: FS_EFFECT_ID });
    if (entries.length === 0) return 0;

    const nodeFs = runtime === "node" ? await maybeNodeFs() : undefined;
    const deno = runtime === "deno" ? (globalRecord.Deno as Record<string, unknown>) : undefined;
    const denoReadFile = deno?.readFile as ((path: string) => Promise<Uint8Array>) | undefined;
    const denoReadTextFile = deno?.readTextFile as ((path: string) => Promise<string>) | undefined;
    const denoWriteFile = deno?.writeFile as ((path: string, data: Uint8Array) => Promise<void>) | undefined;
    const denoWriteTextFile = deno?.writeTextFile as ((path: string, data: string) => Promise<void>) | undefined;
    const denoStat = deno?.stat as ((path: string) => Promise<unknown>) | undefined;
    const denoReadDir = deno?.readDir as ((path: string) => AsyncIterable<{ name: string }>) | undefined;

    const hasNodeFs = !!nodeFs;
    const hasDenoFs =
      !!denoReadFile &&
      !!denoReadTextFile &&
      !!denoWriteFile &&
      !!denoWriteTextFile &&
      !!denoStat &&
      !!denoReadDir;

    if (!hasNodeFs && !hasDenoFs) {
      return registerUnsupportedHandlers({
        host,
        effectId: FS_EFFECT_ID,
        capability: "fs",
        runtime,
        reason: "filesystem APIs are not available",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    const ioErrorCode = (error: unknown): number => {
      const errno = isRecord(error) ? readField(error, "errno") : undefined;
      const parsed = toNumberOrUndefined(errno);
      return parsed === undefined ? 1 : parsed;
    };
    const ioErrorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_bytes",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const bytes = hasNodeFs
            ? await nodeFs!.readFile(resolvedPath)
            : await denoReadFile!(resolvedPath);
          if (bytes.byteLength > effectBufferSize) {
            return tail(
              fsTransportOverflowError({
                opName: "read_bytes",
                effectBufferSize,
              })
            );
          }
          return tail(
            fsSuccessPayload({
              opName: "read_bytes",
              value: Array.from(bytes.values()),
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("read_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_string",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const value = hasNodeFs
            ? new TextDecoder().decode(await nodeFs!.readFile(resolvedPath))
            : await denoReadTextFile!(resolvedPath);
          return tail(
            fsSuccessPayload({
              opName: "read_string",
              value,
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("read_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_bytes",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const bytesValue = readField(payload, "bytes");
          const rawBytes = Array.isArray(bytesValue) ? bytesValue : [];
          const bytes = Uint8Array.from(rawBytes.map(normalizeByte));
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, bytes);
          } else {
            await denoWriteFile!(pathValue, bytes);
          }
          return tail(hostOk());
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("write_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_string",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const value = toStringOrUndefined(readField(payload, "value")) ?? "";
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, value);
          } else {
            await denoWriteTextFile!(pathValue, value);
          }
          return tail(hostOk());
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("write_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "exists",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          if (hasNodeFs) {
            await nodeFs!.access(resolvedPath);
          } else {
            await denoStat!(resolvedPath);
          }
          return tail(true);
        } catch {
          return tail(false);
        }
      },
    });
    implementedOps.add("exists");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "list_dir",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          let names: string[];
          if (hasNodeFs) {
            names = await nodeFs!.readdir(resolvedPath);
          } else {
            names = [];
            for await (const entry of denoReadDir!(resolvedPath)) {
              names.push(entry.name);
            }
          }
          return tail(
            fsSuccessPayload({
              opName: "list_dir",
              value: names.map((name) =>
                joinListDirChildPath({
                  directoryPath: resolvedPath,
                  childName: name,
                })
              ),
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("list_dir");

    return registered + registerMissingOpHandlers({
      host,
      effectId: FS_EFFECT_ID,
      implementedOps,
      diagnostics,
    });
  },
};

const monotonicNow = (runtimeHooks: DefaultAdapterRuntimeHooks): bigint => {
  const hook = runtimeHooks.monotonicNowMillis;
  if (hook) {
    return hook();
  }
  const perf = globalRecord.performance as { now?: () => number } | undefined;
  if (typeof perf?.now === "function") {
    return BigInt(Math.trunc(perf.now()));
  }
  return BigInt(Date.now());
};

const systemNow = (runtimeHooks: DefaultAdapterRuntimeHooks): bigint => {
  const hook = runtimeHooks.systemNowMillis;
  if (hook) {
    return hook();
  }
  return BigInt(Date.now());
};

const timeCapabilityDefinition: CapabilityDefinition = {
  capability: "timer",
  effectId: TIME_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, runtimeHooks }) => {
    const entries = opEntries({ host, effectId: TIME_EFFECT_ID });
    if (entries.length === 0) return 0;
    const hasSleepHook = typeof runtimeHooks.sleepMillis === "function";
    if (!hasSleepHook && typeof setTimeout !== "function") {
      return registerUnsupportedHandlers({
        host,
        effectId: TIME_EFFECT_ID,
        capability: "timer",
        runtime,
        reason: "setTimeout is unavailable",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "monotonic_now_millis",
      handler: ({ tail }) => tail(monotonicNow(runtimeHooks)),
    });
    implementedOps.add("monotonic_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "system_now_millis",
      handler: ({ tail }) => tail(systemNow(runtimeHooks)),
    });
    implementedOps.add("system_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "sleep_millis",
      handler: async ({ tail }, ms) => {
        const sleepMillis = toNonNegativeI64(ms);
        const sleepHook = runtimeHooks.sleepMillis;
        const sleepChunk = sleepHook
          ? (milliseconds: number) => sleepHook(milliseconds)
          : (milliseconds: number) =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, milliseconds);
              });
        await sleepInChunks({
          totalMillis: sleepMillis,
          sleep: sleepChunk,
        });
        return tail(hostOk());
      },
    });
    implementedOps.add("sleep_millis");

    return registered + registerMissingOpHandlers({
      host,
      effectId: TIME_EFFECT_ID,
      implementedOps,
      diagnostics,
    });
  },
};

const envCapabilityDefinition: CapabilityDefinition = {
  capability: "env",
  effectId: ENV_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: ENV_EFFECT_ID });
    if (entries.length === 0) return 0;

    const deno = runtime === "deno" ? (globalRecord.Deno as Record<string, unknown>) : undefined;
    const denoEnv = deno?.env as
      | { get?: (key: string) => string | undefined; set?: (key: string, value: string) => void }
      | undefined;
    const processRecord = globalRecord.process as
      | { env?: Record<string, string | undefined> }
      | undefined;
    const processEnv = runtime === "node" ? processRecord?.env : undefined;

    const hasEnv = !!processEnv || (!!denoEnv?.get && !!denoEnv?.set);
    if (!hasEnv) {
      return registerUnsupportedHandlers({
        host,
        effectId: ENV_EFFECT_ID,
        capability: "env",
        runtime,
        reason: "environment variable APIs are not available",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    registered += registerOpHandler({
      host,
      effectId: ENV_EFFECT_ID,
      opName: "get",
      handler: ({ tail }, keyPayload) => {
        const key = toStringOrUndefined(keyPayload) ?? "";
        try {
          const value = processEnv
            ? processEnv[key]
            : denoEnv?.get
              ? denoEnv.get(key)
              : undefined;
          return tail(value ?? null);
        } catch {
          // Deno can throw when env access is denied; treat as unavailable key.
          return tail(null);
        }
      },
    });
    implementedOps.add("get");

    registered += registerOpHandler({
      host,
      effectId: ENV_EFFECT_ID,
      opName: "set",
      handler: ({ tail }, payload) => {
        try {
          const key = toStringOrUndefined(readField(payload, "key")) ?? "";
          const value = toStringOrUndefined(readField(payload, "value")) ?? "";
          if (processEnv) {
            processEnv[key] = value;
          } else if (denoEnv?.set) {
            denoEnv.set(key, value);
          }
          return tail(hostOk());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return tail(hostError(message));
        }
      },
    });
    implementedOps.add("set");

    return registered + registerMissingOpHandlers({
      host,
      effectId: ENV_EFFECT_ID,
      implementedOps,
      diagnostics,
    });
  },
};

type RandomSource = {
  isAvailable: boolean;
  unavailableReason: string;
  readBytes: (length: number) => Uint8Array;
};

const createRandomSource = ({
  runtimeHooks,
}: {
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): RandomSource => {
  if (typeof runtimeHooks.randomBytes === "function") {
    const randomBytes = runtimeHooks.randomBytes;
    return {
      isAvailable: true,
      unavailableReason: "",
      readBytes: (length) => {
        const fromHook = randomBytes(length);
        if (fromHook.byteLength < length) {
          throw new Error(
            `runtime randomBytes hook returned ${fromHook.byteLength} bytes, expected at least ${length}`
          );
        }
        return fromHook.byteLength === length
          ? fromHook
          : fromHook.subarray(0, length);
      },
    };
  }

  const crypto = globalRecord.crypto as
    | { getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
    | undefined;
  if (typeof crypto?.getRandomValues === "function") {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    return {
      isAvailable: true,
      unavailableReason: "",
      readBytes: (length) => {
        const bytes = new Uint8Array(length);
        for (
          let offset = 0;
          offset < length;
          offset += WEB_CRYPTO_MAX_BYTES_PER_CALL
        ) {
          const end = Math.min(offset + WEB_CRYPTO_MAX_BYTES_PER_CALL, length);
          getRandomValues(bytes.subarray(offset, end));
        }
        return bytes;
      },
    };
  }

  const unavailableReason = "crypto.getRandomValues is unavailable";
  return {
    isAvailable: false,
    unavailableReason,
    readBytes: () => {
      throw new Error(unavailableReason);
    },
  };
};

const maxTransportSafeRandomFillBytes = ({
  effectBufferSize,
}: {
  effectBufferSize: number;
}): number => {
  if (effectBufferSize <= MSGPACK_FIXARRAY_HEADER_BYTES) {
    return 0;
  }

  const arrayHeaderSize = (length: number): number => {
    if (length <= MSGPACK_FIXARRAY_MAX_LENGTH) {
      return MSGPACK_FIXARRAY_HEADER_BYTES;
    }
    if (length <= MSGPACK_ARRAY16_MAX_LENGTH) {
      return MSGPACK_ARRAY16_HEADER_BYTES;
    }
    return MSGPACK_ARRAY32_HEADER_BYTES;
  };

  let low = 0;
  let high = effectBufferSize;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const encodedWorstCaseBytes =
      arrayHeaderSize(mid) + mid * MSGPACK_MAX_BYTES_PER_BYTE_VALUE;
    if (encodedWorstCaseBytes <= effectBufferSize) {
      low = mid;
      continue;
    }
    high = mid - 1;
  }
  return low;
};

const randomCapabilityDefinition: CapabilityDefinition = {
  capability: "random",
  effectId: RANDOM_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: RANDOM_EFFECT_ID });
    if (entries.length === 0) return 0;
    const randomSource = createRandomSource({ runtimeHooks });

    if (!randomSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: RANDOM_EFFECT_ID,
        capability: "random",
        runtime,
        reason: randomSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    registered += registerOpHandler({
      host,
      effectId: RANDOM_EFFECT_ID,
      opName: "next_i64",
      handler: ({ tail }) => {
        const bytes = randomSource.readBytes(8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return tail(view.getBigInt64(0, true));
      },
    });
    implementedOps.add("next_i64");

    registered += registerOpHandler({
      host,
      effectId: RANDOM_EFFECT_ID,
      opName: "fill_bytes",
      handler: ({ tail }, lenPayload) => {
        const requested = Math.max(0, toNumberOrUndefined(lenPayload) ?? 0);
        const length = Math.min(
          Math.trunc(requested),
          RANDOM_FILL_MAX_REQUEST_BYTES,
          maxTransportSafeRandomFillBytes({ effectBufferSize })
        );
        const bytes = randomSource.readBytes(length);
        return tail(Array.from(bytes.values()));
      },
    });
    implementedOps.add("fill_bytes");

    return registered + registerMissingOpHandlers({
      host,
      effectId: RANDOM_EFFECT_ID,
      implementedOps,
      diagnostics,
    });
  },
};

const logCapabilityDefinition: CapabilityDefinition = {
  capability: "log",
  effectId: LOG_EFFECT_ID,
  register: async ({ host, diagnostics, logWriter }) => {
    const entries = opEntries({ host, effectId: LOG_EFFECT_ID });
    if (entries.length === 0) return 0;
    const implementedOps = new Set<string>();
    const registered = registerOpHandler({
      host,
      effectId: LOG_EFFECT_ID,
      opName: "emit",
      handler: ({ tail }, payload) => {
        const level = toStringOrUndefined(readField(payload, "level")) ?? "info";
        const message =
          toStringOrUndefined(readField(payload, "message")) ?? String(readField(payload, "message") ?? "");
        const fieldsValue = readField(payload, "fields");
        const fields = Array.isArray(fieldsValue) ? fieldsValue : [];
        const structured = fields.reduce<Record<string, unknown>>((acc, entry) => {
          const key = toStringOrUndefined(readField(entry, "key"));
          if (!key) return acc;
          acc[key] = readField(entry, "value");
          return acc;
        }, {});
        const method = (
          level === "trace"
            ? logWriter.trace
            : level === "debug"
              ? logWriter.debug
              : level === "warn"
                ? logWriter.warn
                : level === "error"
                  ? logWriter.error
                  : logWriter.info
        ).bind(logWriter);
        method(message, structured);
        return tail();
      },
    });
    implementedOps.add("emit");
    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: LOG_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};

const toFetchHeader = (
  value: unknown
): DefaultAdapterFetchHeader | undefined => {
  if (Array.isArray(value)) {
    const [nameValue, headerValue] = value;
    const name = toStringOrUndefined(nameValue)?.trim();
    if (!name) {
      return undefined;
    }
    return {
      name,
      value: toStringOrUndefined(headerValue) ?? String(headerValue ?? ""),
    };
  }
  const name = toStringOrUndefined(readField(value, "name"))?.trim();
  if (!name) {
    return undefined;
  }
  return {
    name,
    value:
      toStringOrUndefined(readField(value, "value")) ??
      String(readField(value, "value") ?? ""),
  };
};

const normalizeFetchHeaders = (
  value: unknown
): DefaultAdapterFetchHeader[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<DefaultAdapterFetchHeader[]>((headers, entry) => {
    const next = toFetchHeader(entry);
    if (next) {
      headers.push(next);
    }
    return headers;
  }, []);
};

const decodeFetchRequest = (
  payload: unknown
): DefaultAdapterFetchRequest => {
  const url = toStringOrUndefined(readField(payload, "url"))?.trim();
  if (!url) {
    throw new Error("fetch request payload must include a non-empty url");
  }
  const method = toStringOrUndefined(readField(payload, "method"))?.trim();
  const timeoutRaw =
    readField(payload, "timeout_millis") ?? readField(payload, "timeoutMillis");
  const timeoutParsed = toNumberOrUndefined(timeoutRaw);
  return {
    method: method && method.length > 0 ? method.toUpperCase() : "GET",
    url,
    headers: normalizeFetchHeaders(readField(payload, "headers")),
    body: toStringOrUndefined(readField(payload, "body")),
    timeoutMillis:
      timeoutParsed === undefined ? undefined : Math.max(0, Math.trunc(timeoutParsed)),
  };
};

const normalizeFetchResponseHeaders = (
  value: unknown
): DefaultAdapterFetchHeader[] => {
  if (Array.isArray(value)) {
    return value.reduce<DefaultAdapterFetchHeader[]>((headers, entry) => {
      const next = toFetchHeader(entry);
      if (next) {
        headers.push(next);
      }
      return headers;
    }, []);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).reduce<DefaultAdapterFetchHeader[]>(
      (headers, entry) => {
        const next = toFetchHeader(entry);
        if (next) {
          headers.push(next);
        }
        return headers;
      },
      []
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const entries = readField(value, "entries");
  if (typeof entries === "function") {
    const iter = (entries as () => Iterable<unknown>).call(value);
    return Array.from(iter).reduce<DefaultAdapterFetchHeader[]>(
      (headers, entry) => {
        const next = toFetchHeader(entry);
        if (next) {
          headers.push(next);
        }
        return headers;
      },
      []
    );
  }

  const forEach = readField(value, "forEach");
  if (typeof forEach === "function") {
    const headers: DefaultAdapterFetchHeader[] = [];
    (
      forEach as (
        callback: (headerValue: unknown, nameValue: unknown) => void
      ) => void
    ).call(
      value,
      (headerValue: unknown, nameValue: unknown) => {
        const next = toFetchHeader([nameValue, headerValue]);
        if (next) {
          headers.push(next);
        }
      }
    );
    return headers;
  }

  return Object.entries(value).reduce<DefaultAdapterFetchHeader[]>(
    (headers, [nameValue, headerValue]) => {
      const next = toFetchHeader([nameValue, headerValue]);
      if (next) {
        headers.push(next);
      }
      return headers;
    },
    []
  );
};

const decodeFetchResponse = async (
  response: unknown
): Promise<DefaultAdapterFetchResponse> => {
  const status = toNumberOrUndefined(readField(response, "status"));
  if (status === undefined) {
    throw new Error("fetch response is missing status");
  }
  const statusText = toStringOrUndefined(readField(response, "statusText")) ?? "";
  const headers = normalizeFetchResponseHeaders(readField(response, "headers"));
  const text = readField(response, "text");
  if (typeof text === "function") {
    const bodyValue = await (text as () => Promise<unknown>).call(response);
    return {
      status: Math.trunc(status),
      statusText,
      headers,
      body: toStringOrUndefined(bodyValue) ?? String(bodyValue ?? ""),
    };
  }
  return {
    status: Math.trunc(status),
    statusText,
    headers,
    body: toStringOrUndefined(readField(response, "body")) ?? "",
  };
};

const isAbortLikeError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  const code = isRecord(error) ? toStringOrUndefined(readField(error, "code")) : undefined;
  if (code === "ABORT_ERR" || code === "ERR_CANCELED") {
    return true;
  }
  const name = isRecord(error) ? toStringOrUndefined(readField(error, "name")) : undefined;
  if (name === "AbortError") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("aborted") || message.includes("timed out");
};

const fetchErrorCode = (error: unknown): number =>
  isAbortLikeError(error) ? 2 : 1;

const fetchErrorMessage = (error: unknown): string => {
  if (isAbortLikeError(error)) {
    return "fetch request timed out or was aborted";
  }
  return error instanceof Error ? error.message : String(error);
};

const isInputClosedError = (error: unknown): boolean => {
  if (isAbortLikeError(error)) {
    return true;
  }
  const code = isRecord(error) ? toStringOrUndefined(readField(error, "code")) : undefined;
  if (code === "ERR_USE_AFTER_CLOSE") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("readline was closed") ||
    message.includes("input closed") ||
    message.includes("end of input")
  );
};

const inputErrorCode = (error: unknown): number =>
  isInputClosedError(error) ? 2 : 1;

const inputErrorMessage = (error: unknown): string => {
  if (isInputClosedError(error)) {
    return "input stream was closed or aborted";
  }
  return error instanceof Error ? error.message : String(error);
};

const outputErrorCode = (error: unknown): number => {
  const errno = isRecord(error) ? readField(error, "errno") : undefined;
  const parsed = toNumberOrUndefined(errno);
  return parsed === undefined ? 1 : parsed;
};

const outputErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type FetchSource = {
  isAvailable: boolean;
  unavailableReason: string;
  request: (
    input: DefaultAdapterFetchRequest
  ) => Promise<DefaultAdapterFetchResponse>;
};

const createFetchSource = ({
  runtimeHooks,
}: {
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): FetchSource => {
  if (typeof runtimeHooks.fetchRequest === "function") {
    return {
      isAvailable: true,
      unavailableReason: "",
      request: runtimeHooks.fetchRequest,
    };
  }

  const fetchValue = globalRecord.fetch;
  if (typeof fetchValue !== "function") {
    const unavailableReason = "fetch API is unavailable";
    return {
      isAvailable: false,
      unavailableReason,
      request: async () => {
        throw new Error(unavailableReason);
      },
    };
  }

  const fetchFn = (
    fetchValue as (input: string, init?: Record<string, unknown>) => Promise<unknown>
  ).bind(globalThis);

  return {
    isAvailable: true,
    unavailableReason: "",
    request: async (input) => {
      const init: Record<string, unknown> = {
        method: input.method,
        headers: input.headers.map((header) => [header.name, header.value]),
      };
      if (input.body !== undefined) {
        init.body = input.body;
      }

      const timeoutMillis = input.timeoutMillis ?? 0;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMillis > 0) {
        const AbortControllerCtor = globalRecord.AbortController as
          | (new () => { signal: unknown; abort: (reason?: unknown) => void })
          | undefined;
        if (typeof AbortControllerCtor !== "function") {
          throw new Error("fetch timeout_millis requires AbortController support");
        }
        if (typeof setTimeout !== "function") {
          throw new Error("fetch timeout_millis requires setTimeout support");
        }
        const controller = new AbortControllerCtor();
        timeoutHandle = setTimeout(() => {
          controller.abort("timeout");
        }, timeoutMillis);
        init.signal = controller.signal;
      }

      try {
        const response = await fetchFn(input.url, init);
        return await decodeFetchResponse(response);
      } finally {
        if (timeoutHandle !== undefined && typeof clearTimeout === "function") {
          clearTimeout(timeoutHandle);
        }
      }
    },
  };
};

type InputSource = {
  readLine?: (prompt: string | null) => Promise<string | null>;
  readLineUnavailableReason: string;
  readBytes?: (maxBytes: number) => Promise<Uint8Array | null>;
  readBytesUnavailableReason: string;
  isTty: () => boolean;
};

type OutputSource = {
  write?: (output: DefaultAdapterOutputWrite) => Promise<void>;
  writeUnavailableReason: string;
  writeBytes?: (output: DefaultAdapterOutputWriteBytes) => Promise<void>;
  writeBytesUnavailableReason: string;
  flush?: (output: DefaultAdapterOutputFlush) => Promise<void>;
  flushUnavailableReason: string;
  isTty: (target: DefaultAdapterOutputTarget) => boolean;
};

const waitForNodeReadableChunk = async ({
  input,
  maxBytes,
}: {
  input: NodeReadableWithRead;
  maxBytes: number;
}): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const onReadable = (): void => {
      try {
        const chunk = input.read(maxBytes);
        if (chunk === null || chunk === undefined) {
          return;
        }
        cleanup();
        resolve(toUint8Array(chunk).subarray(0, maxBytes));
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      input.removeListener("readable", onReadable);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    input.on("readable", onReadable);
    input.once("end", onEnd);
    input.once("error", onError);
    onReadable();
  });

const readBytesFromNodeStream = async ({
  input,
  maxBytes,
}: {
  input: NodeReadableWithRead;
  maxBytes: number;
}): Promise<Uint8Array | null> => {
  const limit = Math.max(0, Math.trunc(maxBytes));
  if (limit === 0) {
    return new Uint8Array();
  }
  const immediate = input.read(limit);
  if (immediate !== null && immediate !== undefined) {
    return toUint8Array(immediate).subarray(0, limit);
  }
  return waitForNodeReadableChunk({ input, maxBytes: limit });
};

const writeToNodeStream = async ({
  stream,
  value,
}: {
  stream: NodeWritableWithWrite;
  value: string | Uint8Array;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      stream.write(value, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

const flushNodeStream = async (stream: NodeWritableWithWrite): Promise<void> => {
  if (!stream.writableNeedDrain) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
};

const createInputSource = async ({
  runtime,
  runtimeHooks,
}: {
  runtime: HostRuntimeKind;
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): Promise<InputSource> => {
  const promptValue = globalRecord.prompt;
  const promptFn =
    typeof promptValue === "function"
      ? (promptValue as (prompt?: string) => string | null)
      : undefined;

  let readLine = runtimeHooks.readLine;
  let readLineUnavailableReason = readLine
    ? ""
    : "interactive input APIs are unavailable";
  let readBytes = runtimeHooks.readBytes;
  let readBytesUnavailableReason = readBytes
    ? ""
    : "raw stdin byte APIs are unavailable";
  let stdin: NodeReadableWithRead | undefined;
  let stdout: NodeWritableWithWrite | undefined;

  if (!readLine && promptFn) {
    readLine = async (prompt) => {
      const value = promptFn(prompt ?? "");
      return typeof value === "string" ? value : null;
    };
    readLineUnavailableReason = "";
  }

  if (runtime === "node") {
    const processValue = globalRecord.process as
      | {
          stdin?: NodeJS.ReadableStream;
          stdout?: NodeJS.WritableStream;
        }
      | undefined;
    stdin = processValue?.stdin as NodeReadableWithRead | undefined;
    stdout = processValue?.stdout as NodeWritableWithWrite | undefined;

    if (!readLine && stdin && stdout) {
      const readline = await maybeNodeReadlinePromises();
      if (typeof readline?.createInterface === "function") {
        readLine = async (prompt) => {
          const lineReader = readline.createInterface({
            input: stdin!,
            output: stdout!,
            terminal: true,
          });
          try {
            return await lineReader.question(prompt ?? "");
          } catch (error) {
            if (isInputClosedError(error)) {
              return null;
            }
            throw error;
          } finally {
            lineReader.close();
          }
        };
        readLineUnavailableReason = "";
      }
    }

    if (!readBytes && stdin) {
      readBytes = (maxBytes) =>
        readBytesFromNodeStream({
          input: stdin!,
          maxBytes,
        });
      readBytesUnavailableReason = "";
    }
  }

  return {
    readLine,
    readLineUnavailableReason,
    readBytes,
    readBytesUnavailableReason,
    isTty:
      typeof runtimeHooks.isInputTty === "function"
        ? runtimeHooks.isInputTty
        : () => Boolean(stdin?.isTTY),
  };
};

const createOutputSource = ({
  runtime,
  runtimeHooks,
}: {
  runtime: HostRuntimeKind;
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): OutputSource => {
  let stdout: NodeWritableWithWrite | undefined;
  let stderr: NodeWritableWithWrite | undefined;
  if (runtime === "node") {
    const processValue = globalRecord.process as
      | {
          stdout?: NodeJS.WritableStream;
          stderr?: NodeJS.WritableStream;
        }
      | undefined;
    stdout = processValue?.stdout as NodeWritableWithWrite | undefined;
    stderr = processValue?.stderr as NodeWritableWithWrite | undefined;
  }

  const writeFromHook = runtimeHooks.write;
  const writeBytesFromHook = runtimeHooks.writeBytes;
  const flushFromHook = runtimeHooks.flush;
  const streamFor = (target: DefaultAdapterOutputTarget): NodeWritableWithWrite => {
    const stream = target === "stderr" ? stderr : stdout;
    if (!stream) {
      throw new Error("stdout/stderr stream is unavailable");
    }
    return stream;
  };

  const write =
    typeof writeFromHook === "function"
      ? async (output: DefaultAdapterOutputWrite) => writeFromHook(output)
      : typeof writeBytesFromHook === "function"
        ? async ({ target, value }: DefaultAdapterOutputWrite) =>
            writeBytesFromHook({
              target,
              bytes: new TextEncoder().encode(value),
            })
        : stdout && stderr
          ? async ({ target, value }: DefaultAdapterOutputWrite) =>
              writeToNodeStream({
                stream: streamFor(target),
                value,
              })
          : undefined;
  const writeBytes =
    typeof writeBytesFromHook === "function"
      ? async (output: DefaultAdapterOutputWriteBytes) => writeBytesFromHook(output)
      : stdout && stderr
        ? async ({ target, bytes }: DefaultAdapterOutputWriteBytes) =>
            writeToNodeStream({
              stream: streamFor(target),
              value: bytes,
            })
        : undefined;
  const flush =
    typeof flushFromHook === "function"
      ? async (output: DefaultAdapterOutputFlush) => flushFromHook(output)
      : stdout && stderr
        ? async ({ target }: DefaultAdapterOutputFlush) => flushNodeStream(streamFor(target))
        : write || writeBytes
          ? async () => {}
          : undefined;

  const unavailableReason = "stdout/stderr output APIs are unavailable";
  return {
    write,
    writeUnavailableReason: write ? "" : unavailableReason,
    writeBytes,
    writeBytesUnavailableReason: writeBytes ? "" : unavailableReason,
    flush,
    flushUnavailableReason: flush ? "" : unavailableReason,
    isTty:
      typeof runtimeHooks.isOutputTty === "function"
        ? runtimeHooks.isOutputTty
        : (target) => Boolean((target === "stderr" ? stderr : stdout)?.isTTY),
  };
};

const decodeInputPrompt = (payload: unknown): string | null =>
  toStringOrUndefined(readField(payload, "prompt")) ?? null;

const decodeInputReadBytesMaxBytes = (payload: unknown): number => {
  const raw =
    readField(payload, "max_bytes") ?? readField(payload, "maxBytes");
  const parsed = toNumberOrUndefined(raw);
  if (parsed === undefined) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
};

const decodeOutputTarget = (payload: unknown): DefaultAdapterOutputTarget => {
  const target =
    toStringOrUndefined(readField(payload, "target"))?.trim().toLowerCase() ??
    "stdout";
  return target === "stderr" ? "stderr" : "stdout";
};

const decodeOutputWriteValue = (payload: unknown): string =>
  toStringOrUndefined(readField(payload, "value")) ??
  String(readField(payload, "value") ?? "");

const decodeOutputWriteBytes = (payload: unknown): Uint8Array => {
  const rawBytes = readField(payload, "bytes");
  const source = Array.isArray(rawBytes) ? rawBytes : [];
  return Uint8Array.from(source.map(normalizeByte));
};

const INPUT_READ_BYTES_OP_NAMES = ["read_bytes", "read_bytes_op"] as const;
const INPUT_IS_TTY_OP_NAMES = ["is_tty", "is_tty_op"] as const;
const OUTPUT_WRITE_OP_NAMES = ["write", "write_op"] as const;
const OUTPUT_WRITE_BYTES_OP_NAMES = ["write_bytes", "write_bytes_op"] as const;
const OUTPUT_FLUSH_OP_NAMES = ["flush", "flush_op"] as const;
const OUTPUT_IS_TTY_OP_NAMES = ["is_tty", "is_tty_op"] as const;

const fetchCapabilityDefinition: CapabilityDefinition = {
  capability: "fetch",
  effectId: FETCH_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: FETCH_EFFECT_ID });
    if (entries.length === 0) return 0;
    const fetchSource = createFetchSource({ runtimeHooks });
    if (!fetchSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: FETCH_EFFECT_ID,
        capability: "fetch",
        runtime,
        reason: fetchSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    const registered = registerOpHandler({
      host,
      effectId: FETCH_EFFECT_ID,
      opName: "request",
      handler: async ({ tail }, payload) => {
        try {
          const request = decodeFetchRequest(payload);
          const response = await fetchSource.request(request);
          return tail(
            fetchSuccessPayload({
              response,
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(fetchErrorMessage(error), fetchErrorCode(error)));
        }
      },
    });
    implementedOps.add("request");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: FETCH_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};

const inputCapabilityDefinition: CapabilityDefinition = {
  capability: "input",
  effectId: INPUT_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: INPUT_EFFECT_ID });
    if (entries.length === 0) return 0;
    const inputSource = await createInputSource({ runtime, runtimeHooks });

    const implementedOps = new Set<string>();
    let registered = 0;
    if (inputSource.readLine) {
      registered += registerOpHandler({
        host,
        effectId: INPUT_EFFECT_ID,
        opName: "read_line",
        handler: async ({ tail }, payload) => {
          try {
            const prompt = decodeInputPrompt(payload);
            const line = await inputSource.readLine!(prompt);
            return tail(
              inputSuccessPayload({
                opName: "read_line",
                value: line,
                effectBufferSize,
              })
            );
          } catch (error) {
            return tail(hostError(inputErrorMessage(error), inputErrorCode(error)));
          }
        },
      });
      implementedOps.add("read_line");
    }
    if (inputSource.readBytes) {
      registered += registerOpAliasHandlers({
        host,
        effectId: INPUT_EFFECT_ID,
        opNames: INPUT_READ_BYTES_OP_NAMES,
        handler: async ({ tail }, payload) => {
          try {
            const maxBytes = decodeInputReadBytesMaxBytes(payload);
            const bytes = await inputSource.readBytes!(maxBytes);
            const boundedBytes =
              bytes === null ? null : bytes.subarray(0, maxBytes);
            return tail(
              inputSuccessPayload({
                opName: "read_bytes",
                value:
                  boundedBytes === null
                    ? null
                    : Array.from(boundedBytes.values()),
                effectBufferSize,
              })
            );
          } catch (error) {
            return tail(hostError(inputErrorMessage(error), inputErrorCode(error)));
          }
        },
      });
      INPUT_READ_BYTES_OP_NAMES.forEach((opName) => {
        implementedOps.add(opName);
      });
    }
    registered += registerOpAliasHandlers({
      host,
      effectId: INPUT_EFFECT_ID,
      opNames: INPUT_IS_TTY_OP_NAMES,
      handler: ({ tail }) => tail(inputSource.isTty()),
    });
    INPUT_IS_TTY_OP_NAMES.forEach((opName) => {
      implementedOps.add(opName);
    });

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: INPUT_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};

const outputCapabilityDefinition: CapabilityDefinition = {
  capability: "output",
  effectId: OUTPUT_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, runtimeHooks }) => {
    const entries = opEntries({ host, effectId: OUTPUT_EFFECT_ID });
    if (entries.length === 0) return 0;
    const outputSource = createOutputSource({ runtime, runtimeHooks });

    const implementedOps = new Set<string>();
    let registered = 0;
    if (outputSource.write) {
      registered += registerOpAliasHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        opNames: OUTPUT_WRITE_OP_NAMES,
        handler: async ({ tail }, payload) => {
          try {
            await outputSource.write!({
              target: decodeOutputTarget(payload),
              value: decodeOutputWriteValue(payload),
            });
            return tail(hostOk());
          } catch (error) {
            return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
          }
        },
      });
      OUTPUT_WRITE_OP_NAMES.forEach((opName) => {
        implementedOps.add(opName);
      });
    }
    if (outputSource.writeBytes) {
      registered += registerOpAliasHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        opNames: OUTPUT_WRITE_BYTES_OP_NAMES,
        handler: async ({ tail }, payload) => {
          try {
            await outputSource.writeBytes!({
              target: decodeOutputTarget(payload),
              bytes: decodeOutputWriteBytes(payload),
            });
            return tail(hostOk());
          } catch (error) {
            return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
          }
        },
      });
      OUTPUT_WRITE_BYTES_OP_NAMES.forEach((opName) => {
        implementedOps.add(opName);
      });
    }
    if (outputSource.flush) {
      registered += registerOpAliasHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        opNames: OUTPUT_FLUSH_OP_NAMES,
        handler: async ({ tail }, payload) => {
          try {
            await outputSource.flush!({
              target: decodeOutputTarget(payload),
            });
            return tail(hostOk());
          } catch (error) {
            return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
          }
        },
      });
      OUTPUT_FLUSH_OP_NAMES.forEach((opName) => {
        implementedOps.add(opName);
      });
    }
    registered += registerOpAliasHandlers({
      host,
      effectId: OUTPUT_EFFECT_ID,
      opNames: OUTPUT_IS_TTY_OP_NAMES,
      handler: ({ tail }, payload) => tail(outputSource.isTty(decodeOutputTarget(payload))),
    });
    OUTPUT_IS_TTY_OP_NAMES.forEach((opName) => {
      implementedOps.add(opName);
    });

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};

const CAPABILITIES: CapabilityDefinition[] = [
  fsCapabilityDefinition,
  fetchCapabilityDefinition,
  inputCapabilityDefinition,
  outputCapabilityDefinition,
  timeCapabilityDefinition,
  envCapabilityDefinition,
  randomCapabilityDefinition,
  logCapabilityDefinition,
];

export const registerDefaultHostAdapters = async ({
  host,
  options = {},
}: {
  host: DefaultAdapterHost;
  options?: DefaultAdapterOptions;
}): Promise<DefaultAdapterRegistration> => {
  const runtime =
    options.runtime && options.runtime !== "auto"
      ? options.runtime
      : detectHostRuntime();
  const diagnostics: string[] = [];
  const capabilities: DefaultAdapterCapability[] = [];
  let registeredOps = 0;
  const logWriter = options.logWriter ?? console;
  const runtimeHooks = options.runtimeHooks ?? {};
  const effectBufferSize = normalizeEffectBufferSize(options.effectBufferSize);

  for (const capability of CAPABILITIES) {
    const count = await capability.register({
      host,
      runtime,
      diagnostics,
      logWriter,
      runtimeHooks,
      effectBufferSize,
    });
    const hasEffect = opEntries({ host, effectId: capability.effectId }).length > 0;
    if (!hasEffect) {
      continue;
    }
    const unsupported = diagnostics.some(
      (line) =>
        line.startsWith("Registered unsupported") &&
        line.includes(` ${capability.effectId} `)
    );
    capabilities.push({
      capability: capability.capability,
      effectId: capability.effectId,
      registeredOps: count,
      supported: !unsupported,
      reason: unsupported
        ? diagnostics.find((line) => line.includes(` ${capability.effectId} `))
        : undefined,
    });
    registeredOps += count;
  }

  diagnostics.forEach((message) => {
    options.onDiagnostic?.(message);
  });

  return {
    runtime,
    registeredOps,
    capabilities,
  };
};
