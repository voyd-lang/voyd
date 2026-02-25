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
const WEB_CRYPTO_MAX_BYTES_PER_CALL = 65_536;
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;
const MAX_TIMER_DELAY_MILLIS_BIGINT = 2_147_483_647n;
const RANDOM_FILL_MAX_REQUEST_BYTES = 1_000_000;
const MSGPACK_ARRAY16_HEADER_BYTES = 3;
const MSGPACK_MAX_BYTES_PER_BYTE_VALUE = 2;

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

export type DefaultAdapterRuntimeHooks = {
  monotonicNowMillis?: () => bigint;
  systemNowMillis?: () => bigint;
  sleepMillis?: (ms: number) => Promise<void>;
  randomBytes?: (length: number) => Uint8Array;
};

export type DefaultAdapterOptions = {
  runtime?: HostRuntimeKind | "auto";
  onDiagnostic?: (message: string) => void;
  logWriter?: Pick<Console, "trace" | "debug" | "info" | "warn" | "error">;
  runtimeHooks?: DefaultAdapterRuntimeHooks;
  effectBufferSize?: number;
};

export type DefaultAdapterCapability = {
  capability: "fs" | "timer" | "env" | "random" | "log" | "fetch" | "input";
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
  register: async ({ host, runtime, diagnostics }) => {
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
          return tail(hostOk(Array.from(bytes.values())));
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
          return tail(hostOk(value));
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
            hostOk(
              names.map((name) =>
                joinListDirChildPath({
                  directoryPath: resolvedPath,
                  childName: name,
                })
              )
            )
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

const readRandomBytes = ({
  length,
  runtimeHooks,
}: {
  length: number;
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): Uint8Array => {
  if (runtimeHooks.randomBytes) {
    const fromHook = runtimeHooks.randomBytes(length);
    if (fromHook.byteLength < length) {
      throw new Error(
        `runtime randomBytes hook returned ${fromHook.byteLength} bytes, expected at least ${length}`
      );
    }
    if (fromHook.byteLength === length) {
      return fromHook;
    }
    return fromHook.subarray(0, length);
  }
  const crypto = globalRecord.crypto as
    | { getRandomValues: <T extends ArrayBufferView>(array: T) => T }
    | undefined;
  if (!crypto?.getRandomValues) {
    throw new Error("crypto.getRandomValues is unavailable");
  }
  const bytes = new Uint8Array(length);
  for (
    let offset = 0;
    offset < length;
    offset += WEB_CRYPTO_MAX_BYTES_PER_CALL
  ) {
    const end = Math.min(offset + WEB_CRYPTO_MAX_BYTES_PER_CALL, length);
    crypto.getRandomValues(bytes.subarray(offset, end));
  }
  return bytes;
};

const hasRandomByteSource = ({
  runtimeHooks,
}: {
  runtimeHooks: DefaultAdapterRuntimeHooks;
}): boolean => {
  if (typeof runtimeHooks.randomBytes === "function") {
    return true;
  }
  const crypto = globalRecord.crypto as
    | { getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
    | undefined;
  return typeof crypto?.getRandomValues === "function";
};

const maxTransportSafeRandomFillBytes = ({
  effectBufferSize,
}: {
  effectBufferSize: number;
}): number => {
  if (effectBufferSize <= MSGPACK_ARRAY16_HEADER_BYTES) {
    return 0;
  }
  return Math.floor(
    (effectBufferSize - MSGPACK_ARRAY16_HEADER_BYTES) /
      MSGPACK_MAX_BYTES_PER_BYTE_VALUE
  );
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

    if (!hasRandomByteSource({ runtimeHooks })) {
      return registerUnsupportedHandlers({
        host,
        effectId: RANDOM_EFFECT_ID,
        capability: "random",
        runtime,
        reason: "crypto.getRandomValues is unavailable",
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
        const bytes = readRandomBytes({ length: 8, runtimeHooks });
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
        const bytes = readRandomBytes({ length, runtimeHooks });
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

const fetchCapabilityDefinition: CapabilityDefinition = {
  capability: "fetch",
  effectId: FETCH_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: FETCH_EFFECT_ID });
    if (entries.length === 0) return 0;
    return registerUnsupportedHandlers({
      host,
      effectId: FETCH_EFFECT_ID,
      capability: "fetch",
      runtime,
      reason:
        "std::fetch::Fetch effect contract is not finalized in stdlib yet; default adapter cannot safely infer payload schema",
      diagnostics,
    });
  },
};

const inputCapabilityDefinition: CapabilityDefinition = {
  capability: "input",
  effectId: INPUT_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: INPUT_EFFECT_ID });
    if (entries.length === 0) return 0;
    return registerUnsupportedHandlers({
      host,
      effectId: INPUT_EFFECT_ID,
      capability: "input",
      runtime,
      reason:
        "std::input::Input effect contract is not finalized in stdlib yet; default adapter cannot safely infer payload schema",
      diagnostics,
    });
  },
};

const CAPABILITIES: CapabilityDefinition[] = [
  fsCapabilityDefinition,
  fetchCapabilityDefinition,
  inputCapabilityDefinition,
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
