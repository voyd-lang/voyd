import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
} from "../protocol/types.js";
import {
  registerDefaultHostAdapters,
  type DefaultAdapterHost,
} from "./default.js";

const buildTable = (
  ops: Array<{ effectId: string; opName: string; opId: number }>
): HostProtocolTable => ({
  version: 2,
  ops: ops.map((op, index) => ({
    opIndex: index,
    effectId: op.effectId,
    opId: op.opId,
    opName: op.opName,
    resumeKind: "tail",
    signatureHash: `0x${(index + 1).toString(16).padStart(8, "0")}`,
    label: `${op.effectId}.${op.opName}`,
  })),
});

type HandlerRegistry = Map<string, EffectHandler>;

const createFakeHost = (
  table: HostProtocolTable
): {
  host: DefaultAdapterHost;
  handlers: HandlerRegistry;
  getHandler: (effectId: string, opName: string) => EffectHandler;
} => {
  const handlers: HandlerRegistry = new Map();
  const host: DefaultAdapterHost = {
    table,
    registerHandler: (
      effectId: string,
      opId: number,
      signatureHash: SignatureHash,
      handler: EffectHandler
    ) => {
      handlers.set(`${effectId}:${opId}:${signatureHash}`, handler);
    },
  };
  const getHandler = (effectId: string, opName: string): EffectHandler => {
    const op = table.ops.find(
      (entry) => entry.effectId === effectId && entry.opName === opName
    );
    if (!op) {
      throw new Error(`missing op ${effectId}.${opName}`);
    }
    const key = `${op.effectId}:${op.opId}:${op.signatureHash}`;
    const handler = handlers.get(key);
    if (!handler) {
      throw new Error(`missing handler for ${effectId}.${opName}`);
    }
    return handler;
  };
  return { host, handlers, getHandler };
};

const continuationCall = (
  kind: "resume" | "tail" | "end",
  value?: unknown
): EffectContinuationCall => ({ kind, value });

const tailContinuation: EffectContinuation = {
  resume: (value?: unknown) => continuationCall("resume", value),
  tail: (value?: unknown) => continuationCall("tail", value),
  end: (value?: unknown) => continuationCall("end", value),
};

describe("registerDefaultHostAdapters", () => {
  const envKey = "VOYD_JS_HOST_DEFAULT_ADAPTER_TEST_KEY";
  const originalEnvValue = process.env[envKey];

  beforeEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnvValue;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers node env handlers that set and read values", async () => {
    const table = buildTable([
      { effectId: "std::env::Env", opName: "get", opId: 0 },
      { effectId: "std::env::Env", opName: "set", opId: 1 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });
    expect(report.registeredOps).toBeGreaterThanOrEqual(2);

    const setHandler = getHandler("std::env::Env", "set");
    const setResult = await setHandler(tailContinuation, {
      key: envKey,
      value: "hello",
    });
    expect(setResult.kind).toBe("tail");
    expect(setResult.value).toMatchObject({ ok: true });

    const getEnvHandler = getHandler("std::env::Env", "get");
    const getResult = await getEnvHandler(tailContinuation, envKey);
    expect(getResult.kind).toBe("tail");
    expect(getResult.value).toBe("hello");
  });

  it("registers random/time/log handlers on node", async () => {
    const trace = vi.fn();
    const info = vi.fn();
    const table = buildTable([
      { effectId: "std::random::Random", opName: "next_i64", opId: 0 },
      { effectId: "std::random::Random", opName: "fill_bytes", opId: 1 },
      { effectId: "std::time::Time", opName: "monotonic_now_millis", opId: 2 },
      { effectId: "std::time::Time", opName: "system_now_millis", opId: 3 },
      { effectId: "std::time::Time", opName: "sleep_millis", opId: 4 },
      { effectId: "std::log::Log", opName: "emit", opId: 5 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "node",
        logWriter: {
          trace,
          debug: trace,
          info,
          warn: info,
          error: info,
        },
      },
    });

    const random64 = await getHandler("std::random::Random", "next_i64")(
      tailContinuation
    );
    expect(typeof random64.value).toBe("bigint");

    const randomBytes = await getHandler("std::random::Random", "fill_bytes")(
      tailContinuation,
      8
    );
    expect(Array.isArray(randomBytes.value)).toBe(true);
    expect((randomBytes.value as unknown[]).length).toBe(8);

    const mono = await getHandler("std::time::Time", "monotonic_now_millis")(
      tailContinuation
    );
    const sys = await getHandler("std::time::Time", "system_now_millis")(
      tailContinuation
    );
    expect(typeof mono.value).toBe("bigint");
    expect(typeof sys.value).toBe("bigint");

    const slept = await getHandler("std::time::Time", "sleep_millis")(
      tailContinuation,
      0n
    );
    expect(slept.value).toMatchObject({ ok: true });

    await getHandler("std::log::Log", "emit")(tailContinuation, {
      level: "info",
      message: "hello",
      fields: [{ key: "x", value: 1 }],
    });
    expect(info).toHaveBeenCalled();
  });

  it("registers actionable unsupported handlers on browser for fs", async () => {
    const table = buildTable([
      { effectId: "std::fs::Fs", opName: "read_string", opId: 0 },
    ]);
    const diagnostics: string[] = [];
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        onDiagnostic: (message) => diagnostics.push(message),
      },
    });

    expect(report.capabilities.find((cap) => cap.effectId === "std::fs::Fs")?.supported).toBe(
      false
    );
    const handler = getHandler("std::fs::Fs", "read_string");
    await expect((async () => handler(tailContinuation, "/tmp/file"))()).rejects.toThrow(
      /Default fs adapter is unavailable on browser/i
    );
    expect(diagnostics.some((message) => message.includes("unsupported fs"))).toBe(true);
  });

  it("probes node fs when runtime is forced to node", async () => {
    const table = buildTable([
      { effectId: "std::fs::Fs", opName: "read_string", opId: 0 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "std::fs::Fs")
        ?.supported
    ).toBe(true);

    const result = await getHandler("std::fs::Fs", "read_string")(
      tailContinuation,
      "/this/path/does/not/exist"
    );
    expect(result.kind).toBe("tail");
    expect(result.value).toMatchObject({ ok: false });
  });

  it("chunks browser random fills to avoid WebCrypto quota errors", async () => {
    const table = buildTable([
      { effectId: "std::random::Random", opName: "fill_bytes", opId: 0 },
    ]);
    const chunkSizes: number[] = [];
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        chunkSizes.push(array.byteLength);
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength
        );
        bytes.fill(7);
        return array;
      },
    });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "browser" },
    });
    chunkSizes.length = 0;

    const result = await getHandler("std::random::Random", "fill_bytes")(
      tailContinuation,
      70_000
    );
    expect(result.kind).toBe("tail");
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as unknown[]).length).toBe(70_000);
    expect(chunkSizes).toEqual([65_536, 4_464]);
  });

  it("returns null for denied deno env reads", async () => {
    const table = buildTable([
      { effectId: "std::env::Env", opName: "get", opId: 0 },
      { effectId: "std::env::Env", opName: "set", opId: 1 },
    ]);
    vi.stubGlobal("Deno", {
      env: {
        get: () => {
          throw new Error("PermissionDenied");
        },
        set: () => {},
      },
    });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "deno" },
    });

    const result = await getHandler("std::env::Env", "get")(
      tailContinuation,
      "HOME"
    );
    expect(result.kind).toBe("tail");
    expect(result.value).toBeNull();
  });
});
