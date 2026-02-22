import type { EffectHandler, HostProtocolTable, SignatureHash } from "../protocol/types.js";
import type { HostRuntimeKind } from "../runtime/environment.js";
import { detectHostRuntime } from "../runtime/environment.js";

const FS_EFFECT_ID = "std::fs::Fs";
const TIME_EFFECT_ID = "std::time::Time";
const ENV_EFFECT_ID = "std::env::Env";
const RANDOM_EFFECT_ID = "std::random::Random";
const LOG_EFFECT_ID = "std::log::Log";
const FETCH_EFFECT_ID = "std::fetch::Fetch";
const INPUT_EFFECT_ID = "std::input::Input";

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

export type DefaultAdapterOptions = {
  runtime?: HostRuntimeKind | "auto";
  onDiagnostic?: (message: string) => void;
  logWriter?: Pick<Console, "trace" | "debug" | "info" | "warn" | "error">;
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
  if (detectHostRuntime() !== "node") return undefined;
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const nodeFsSpecifier = ["node", "fs/promises"].join(":");
    const mod = await importModule(nodeFsSpecifier);
    return mod as unknown as NodeFsPromises;
  } catch {
    return undefined;
  }
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
          return tail(hostOk(names.map((name) => `${resolvedPath}/${name}`)));
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

const monotonicNow = (): bigint => {
  const perf = globalRecord.performance as { now?: () => number } | undefined;
  if (typeof perf?.now === "function") {
    return BigInt(Math.trunc(perf.now()));
  }
  return BigInt(Date.now());
};

const timeCapabilityDefinition: CapabilityDefinition = {
  capability: "timer",
  effectId: TIME_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: TIME_EFFECT_ID });
    if (entries.length === 0) return 0;
    if (typeof setTimeout !== "function") {
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
      handler: ({ tail }) => tail(monotonicNow()),
    });
    implementedOps.add("monotonic_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "system_now_millis",
      handler: ({ tail }) => tail(BigInt(Date.now())),
    });
    implementedOps.add("system_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "sleep_millis",
      handler: async ({ tail }, ms) => {
        const sleepMs = Math.max(0, Number(toI64(ms)));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(sleepMs, 2_147_483_647));
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
        const value = processEnv
          ? processEnv[key]
          : denoEnv?.get
            ? denoEnv.get(key)
            : undefined;
        return tail(value ?? null);
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

const readRandomBytes = (length: number): Uint8Array => {
  const crypto = globalRecord.crypto as
    | { getRandomValues: <T extends ArrayBufferView>(array: T) => T }
    | undefined;
  if (!crypto?.getRandomValues) {
    throw new Error("crypto.getRandomValues is unavailable");
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const randomCapabilityDefinition: CapabilityDefinition = {
  capability: "random",
  effectId: RANDOM_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: RANDOM_EFFECT_ID });
    if (entries.length === 0) return 0;

    try {
      readRandomBytes(1);
    } catch {
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
        const bytes = readRandomBytes(8);
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
        const length = Math.min(Math.trunc(requested), 1_000_000);
        const bytes = readRandomBytes(length);
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

  for (const capability of CAPABILITIES) {
    const count = await capability.register({
      host,
      runtime,
      diagnostics,
      logWriter,
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
