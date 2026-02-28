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

const toStringOrUndefinedFromRecord = (
  value: unknown,
  key: string
): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};

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
      { effectId: "voyd.std.env", opName: "get", opId: 0 },
      { effectId: "voyd.std.env", opName: "set", opId: 1 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });
    expect(report.registeredOps).toBeGreaterThanOrEqual(2);

    const setHandler = getHandler("voyd.std.env", "set");
    const setResult = await setHandler(tailContinuation, {
      key: envKey,
      value: "hello",
    });
    expect(setResult.kind).toBe("tail");
    expect(setResult.value).toMatchObject({ ok: true });

    const getEnvHandler = getHandler("voyd.std.env", "get");
    const getResult = await getEnvHandler(tailContinuation, envKey);
    expect(getResult.kind).toBe("tail");
    expect(getResult.value).toBe("hello");
  });

  it("registers random/time/log handlers on node", async () => {
    const trace = vi.fn();
    const info = vi.fn();
    const table = buildTable([
      { effectId: "voyd.std.random", opName: "next_i64", opId: 0 },
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 1 },
      { effectId: "voyd.std.time", opName: "monotonic_now_millis", opId: 2 },
      { effectId: "voyd.std.time", opName: "system_now_millis", opId: 3 },
      { effectId: "voyd.std.time", opName: "sleep_millis", opId: 4 },
      { effectId: "voyd.std.time", opName: "set_timeout_millis", opId: 5 },
      { effectId: "voyd.std.time", opName: "set_interval_millis", opId: 6 },
      { effectId: "voyd.std.time", opName: "clear_timer", opId: 7 },
      { effectId: "voyd.std.log", opName: "emit", opId: 8 },
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

    const random64 = await getHandler("voyd.std.random", "next_i64")(
      tailContinuation
    );
    expect(typeof random64.value).toBe("bigint");

    const randomBytes = await getHandler("voyd.std.random", "fill_bytes")(
      tailContinuation,
      8
    );
    expect(Array.isArray(randomBytes.value)).toBe(true);
    expect((randomBytes.value as unknown[]).length).toBe(8);

    const mono = await getHandler("voyd.std.time", "monotonic_now_millis")(
      tailContinuation
    );
    const sys = await getHandler("voyd.std.time", "system_now_millis")(
      tailContinuation
    );
    expect(typeof mono.value).toBe("bigint");
    expect(typeof sys.value).toBe("bigint");

    const slept = await getHandler("voyd.std.time", "sleep_millis")(
      tailContinuation,
      0n
    );
    expect(slept.value).toMatchObject({ ok: true });

    const timeout = await getHandler("voyd.std.time", "set_timeout_millis")(
      tailContinuation,
      0n
    );
    expect(timeout.value).toMatchObject({ ok: true });

    const interval = await getHandler("voyd.std.time", "set_interval_millis")(
      tailContinuation,
      0n
    );
    expect(interval.value).toMatchObject({ ok: true, value: 1n });

    const clear = await getHandler("voyd.std.time", "clear_timer")(
      tailContinuation,
      1n
    );
    expect(clear.value).toMatchObject({ ok: true });

    await getHandler("voyd.std.log", "emit")(tailContinuation, {
      level: "info",
      message: "hello",
      fields: [{ key: "x", value: 1 }],
    });
    expect(info).toHaveBeenCalled();
  });

  it("reports capabilities in the adapter registration order", async () => {
    const table = buildTable([
      { effectId: "voyd.std.log", opName: "emit", opId: 0 },
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 1 },
      { effectId: "voyd.std.env", opName: "get", opId: 2 },
      { effectId: "voyd.std.time", opName: "system_now_millis", opId: 3 },
    ]);
    const { host } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    expect(report.capabilities.map((capability) => capability.effectId)).toEqual([
      "voyd.std.time",
      "voyd.std.env",
      "voyd.std.random",
      "voyd.std.log",
    ]);
  });

  it("chains timers for long sleep durations", async () => {
    const table = buildTable([
      { effectId: "voyd.std.time", opName: "sleep_millis", opId: 0 },
    ]);
    const delays: number[] = [];
    const setTimeoutSpy = vi.fn((task: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      task();
      return 0;
    });
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    const longSleep =
      2_147_483_647n + 2_147_483_647n + 123n;
    const result = await getHandler("voyd.std.time", "sleep_millis")(
      tailContinuation,
      longSleep
    );

    expect(result.kind).toBe("tail");
    expect(result.value).toMatchObject({ ok: true });
    expect(delays).toEqual([2_147_483_647, 2_147_483_647, 123]);
  });

  it("cancels fallback interval timers when clear_timer is invoked", async () => {
    const table = buildTable([
      { effectId: "voyd.std.time", opName: "set_interval_millis", opId: 0 },
      { effectId: "voyd.std.time", opName: "clear_timer", opId: 1 },
    ]);
    let nextTimeoutToken = 1;
    const scheduled = new Map<number, { delay: number }>();
    const setTimeoutSpy = vi.fn((_task: () => void, delay?: number) => {
      const token = nextTimeoutToken;
      nextTimeoutToken += 1;
      scheduled.set(token, { delay: delay ?? 0 });
      return token;
    });
    const clearTimeoutSpy = vi.fn((token: number) => {
      scheduled.delete(token);
    });
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    const intervalResult = await getHandler("voyd.std.time", "set_interval_millis")(
      tailContinuation,
      5_000n
    );
    expect(intervalResult.value).toMatchObject({ ok: true, value: 1n });
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(scheduled.size).toBe(1);

    const clearResult = await getHandler("voyd.std.time", "clear_timer")(
      tailContinuation,
      1n
    );
    expect(clearResult.value).toMatchObject({ ok: true });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(scheduled.size).toBe(0);
  });

  it("registers actionable unsupported handlers on browser for fs", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fs", opName: "read_string", opId: 0 },
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

    expect(report.capabilities.find((cap) => cap.effectId === "voyd.std.fs")?.supported).toBe(
      false
    );
    const handler = getHandler("voyd.std.fs", "read_string");
    await expect((async () => handler(tailContinuation, "/tmp/file"))()).rejects.toThrow(
      /Default fs adapter is unavailable on browser/i
    );
    expect(diagnostics.some((message) => message.includes("unsupported fs"))).toBe(true);
  });

  it("probes node fs when runtime is forced to node", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fs", opName: "read_string", opId: 0 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.fs")
        ?.supported
    ).toBe(true);

    const result = await getHandler("voyd.std.fs", "read_string")(
      tailContinuation,
      "/this/path/does/not/exist"
    );
    expect(result.kind).toBe("tail");
    expect(result.value).toMatchObject({ ok: false });
  });

  it("normalizes list_dir child paths for root and trailing separators", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fs", opName: "list_dir", opId: 0 },
    ]);
    vi.stubGlobal("Deno", {
      readFile: async () => new Uint8Array(),
      readTextFile: async () => "",
      writeFile: async () => {},
      writeTextFile: async () => {},
      stat: async () => ({}),
      readDir: (path: string) => ({
        async *[Symbol.asyncIterator]() {
          if (path === "/") {
            yield { name: "tmp" };
            yield { name: "var" };
            return;
          }
          yield { name: "child" };
        },
      }),
    });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "deno" },
    });

    const listDir = getHandler("voyd.std.fs", "list_dir");
    const rootResult = await listDir(tailContinuation, "/");
    expect(rootResult).toEqual({
      kind: "tail",
      value: { ok: true, value: ["/tmp", "/var"] },
    });

    const nestedResult = await listDir(tailContinuation, "/tmp/");
    expect(nestedResult).toEqual({
      kind: "tail",
      value: { ok: true, value: ["/tmp/child"] },
    });
  });

  it("returns io errors when fs read/list payloads exceed transport buffer", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fs", opName: "read_bytes", opId: 0 },
      { effectId: "voyd.std.fs", opName: "read_string", opId: 1 },
      { effectId: "voyd.std.fs", opName: "list_dir", opId: 2 },
    ]);
    vi.stubGlobal("Deno", {
      readFile: async () => Uint8Array.from(Array.from({ length: 128 }, () => 7)),
      readTextFile: async () => "x".repeat(256),
      writeFile: async () => {},
      writeTextFile: async () => {},
      stat: async () => ({}),
      readDir: () => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 16; index += 1) {
            yield { name: `entry-${index}-with-long-name` };
          }
        },
      }),
    });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "deno",
        effectBufferSize: 64,
      },
    });

    const readBytesResult = await getHandler("voyd.std.fs", "read_bytes")(
      tailContinuation,
      "/tmp/blob"
    );
    expect(readBytesResult.kind).toBe("tail");
    expect(readBytesResult.value).toMatchObject({
      ok: false,
      code: 1,
    });
    expect(
      toStringOrUndefinedFromRecord(readBytesResult.value, "message")
    ).toMatch(/read_bytes response exceeds effect transport buffer/i);

    const readStringResult = await getHandler("voyd.std.fs", "read_string")(
      tailContinuation,
      "/tmp/text"
    );
    expect(readStringResult.kind).toBe("tail");
    expect(readStringResult.value).toMatchObject({
      ok: false,
      code: 1,
    });
    expect(
      toStringOrUndefinedFromRecord(readStringResult.value, "message")
    ).toMatch(/read_string response exceeds effect transport buffer/i);

    const listDirResult = await getHandler("voyd.std.fs", "list_dir")(
      tailContinuation,
      "/tmp"
    );
    expect(listDirResult.kind).toBe("tail");
    expect(listDirResult.value).toMatchObject({
      ok: false,
      code: 1,
    });
    expect(
      toStringOrUndefinedFromRecord(listDirResult.value, "message")
    ).toMatch(/list_dir response exceeds effect transport buffer/i);
  });

  it("registers fetch handlers and maps DTO payloads", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fetch", opName: "request", opId: 0 },
    ]);
    const seenRequests: unknown[] = [];
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "node",
        runtimeHooks: {
          fetchRequest: async (request) => {
            seenRequests.push(request);
            return {
              status: 201,
              statusText: "Created",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: request.body ?? "",
            };
          },
        },
      },
    });

    const result = await getHandler("voyd.std.fetch", "request")(
      tailContinuation,
      {
        method: "post",
        url: "https://example.test/echo",
        headers: [{ name: "accept", value: "text/plain" }],
        body: "hello",
        timeout_millis: 15,
      }
    );

    expect(seenRequests).toEqual([
      {
        method: "POST",
        url: "https://example.test/echo",
        headers: [{ name: "accept", value: "text/plain" }],
        body: "hello",
        timeoutMillis: 15,
      },
    ]);
    expect(result).toEqual({
      kind: "tail",
      value: {
        ok: true,
        value: {
          status: 201,
          status_text: "Created",
          headers: [{ name: "content-type", value: "text/plain" }],
          body: "hello",
        },
      },
    });
  });

  it("returns host timeout errors when fetch aborts", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fetch", opName: "request", opId: 0 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          void resolve;
          if (init?.signal?.aborted) {
            const error = new Error("deadline exceeded");
            error.name = "AbortError";
            reject(error);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("deadline exceeded");
            error.name = "AbortError";
            reject(error);
          });
        });
      })
    );
    vi.stubGlobal(
      "setTimeout",
      vi.fn((task: () => void, _delay?: number) => {
        task();
        return 0;
      })
    );
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    const result = await getHandler("voyd.std.fetch", "request")(
      tailContinuation,
      {
        method: "GET",
        url: "https://example.test/timeout",
        headers: [],
        timeout_millis: 5,
      }
    );
    expect(result).toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 2,
        message: "fetch request timed out or was aborted",
      },
    });
  });

  it("preserves fetch timeout capability errors when abort support is unavailable", async () => {
    const table = buildTable([
      { effectId: "voyd.std.fetch", opName: "request", opId: 0 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        statusText: "OK",
        headers: [],
        text: async () => "",
      }))
    );
    vi.stubGlobal("AbortController", undefined);
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    const result = await getHandler("voyd.std.fetch", "request")(
      tailContinuation,
      {
        method: "GET",
        url: "https://example.test/timeout",
        headers: [],
        timeout_millis: 5,
      }
    );
    expect(result).toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 1,
        message: "fetch timeout_millis requires AbortController support",
      },
    });
  });

  it("registers input handlers from runtime hooks", async () => {
    const table = buildTable([
      { effectId: "voyd.std.input", opName: "read_line", opId: 0 },
      { effectId: "voyd.std.input", opName: "read_bytes", opId: 1 },
      { effectId: "voyd.std.input", opName: "is_tty", opId: 2 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "node",
        runtimeHooks: {
          readLine: async (prompt) => {
            if (prompt === "fail") {
              throw new Error("input unavailable");
            }
            return prompt === "eof" ? null : "voyd";
          },
          readBytes: async (maxBytes) => {
            if (maxBytes === 13) {
              throw new Error("bytes unavailable");
            }
            if (maxBytes === 0) {
              return null;
            }
            return Uint8Array.from([7, 8, 9]);
          },
          isInputTty: () => true,
        },
      },
    });

    await expect(
      getHandler("voyd.std.input", "read_line")(tailContinuation, {
        prompt: "Name: ",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: "voyd" },
    });

    await expect(
      getHandler("voyd.std.input", "read_line")(tailContinuation, {
        prompt: "eof",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: null },
    });

    await expect(
      getHandler("voyd.std.input", "read_line")(tailContinuation, {
        prompt: "fail",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 1,
        message: "input unavailable",
      },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 2,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: [7, 8] },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 8,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: [7, 8, 9] },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 0,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: null },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 13,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 1,
        message: "bytes unavailable",
      },
    });

    expect(getHandler("voyd.std.input", "is_tty")(tailContinuation)).toEqual({
      kind: "tail",
      value: true,
    });
  });

  it("registers output handlers from runtime hooks", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
      { effectId: "voyd.std.output", opName: "write_bytes", opId: 1 },
      { effectId: "voyd.std.output", opName: "flush", opId: 2 },
      { effectId: "voyd.std.output", opName: "is_tty", opId: 3 },
    ]);
    const writes: Array<{ target: string; value: string }> = [];
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const flushes: string[] = [];
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "node",
        runtimeHooks: {
          write: async ({ target, value }) => {
            if (value === "fail") {
              throw new Error("write failed");
            }
            writes.push({ target, value });
          },
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
          flush: async ({ target }) => {
            flushes.push(target);
          },
          isOutputTty: (target) => target === "stdout",
        },
      },
    });

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "hello",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "fail",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 1,
        message: "write failed",
      },
    });

    await expect(
      getHandler("voyd.std.output", "write_bytes")(tailContinuation, {
        target: "stderr",
        bytes: [7, 8, 9],
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });

    await expect(
      getHandler("voyd.std.output", "flush")(tailContinuation, {
        target: "stderr",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });

    expect(
      getHandler("voyd.std.output", "is_tty")(tailContinuation, {
        target: "stdout",
      })
    ).toEqual({
      kind: "tail",
      value: true,
    });

    expect(
      getHandler("voyd.std.output", "is_tty")(tailContinuation, {
        target: "stderr",
      })
    ).toEqual({
      kind: "tail",
      value: false,
    });

    expect(writes).toEqual([{ target: "stdout", value: "hello" }]);
    expect(byteWrites).toEqual([{ target: "stderr", bytes: [7, 8, 9] }]);
    expect(flushes).toEqual(["stderr"]);
  });

  it("registers fallback input handlers when runtime lacks requested ops", async () => {
    const table = buildTable([
      { effectId: "voyd.std.input", opName: "read_bytes", opId: 0 },
    ]);
    vi.stubGlobal("prompt", undefined);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "browser" },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.input")
        ?.supported
    ).toBe(true);

    await expect(
      (async () =>
        getHandler("voyd.std.input", "read_bytes")(tailContinuation, {}))()
    ).rejects.toThrow(/does not implement op read_bytes/i);
  });

  it("keeps input read_bytes active when read_line is unavailable", async () => {
    const table = buildTable([
      { effectId: "voyd.std.input", opName: "read_line", opId: 0 },
      { effectId: "voyd.std.input", opName: "read_bytes", opId: 1 },
      { effectId: "voyd.std.input", opName: "is_tty", opId: 2 },
    ]);
    vi.stubGlobal("prompt", undefined);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        runtimeHooks: {
          readBytes: async () => Uint8Array.from([7, 8, 9]),
          isInputTty: () => true,
        },
      },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.input")
        ?.supported
    ).toBe(true);

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 2,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: [7, 8] },
    });
    expect(getHandler("voyd.std.input", "is_tty")(tailContinuation)).toEqual({
      kind: "tail",
      value: true,
    });
    await expect(
      (async () =>
        getHandler("voyd.std.input", "read_line")(tailContinuation, {
          prompt: "name: ",
        }))()
    ).rejects.toThrow(/does not implement op read_line/i);
  });

  it("returns eof for read_bytes when node stdin is already ended", async () => {
    const table = buildTable([
      { effectId: "voyd.std.input", opName: "read_bytes", opId: 0 },
    ]);
    const stdin: any = {
      readableEnded: true,
      isTTY: false,
    };
    stdin.read = vi.fn(() => null);
    stdin.on = vi.fn(() => stdin);
    stdin.once = vi.fn(() => stdin);
    stdin.removeListener = vi.fn(() => stdin);
    vi.stubGlobal("process", { stdin });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 4,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true, value: null },
    });
  });

  it("returns an error when node stdin is configured for text chunks", async () => {
    const table = buildTable([
      { effectId: "voyd.std.input", opName: "read_bytes", opId: 0 },
    ]);
    const stdin: any = {
      readableEnded: false,
      isTTY: false,
    };
    stdin.read = vi.fn(() => "abc");
    stdin.on = vi.fn(() => stdin);
    stdin.once = vi.fn(() => stdin);
    stdin.removeListener = vi.fn(() => stdin);
    vi.stubGlobal("process", { stdin });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: { runtime: "node" },
    });

    await expect(
      getHandler("voyd.std.input", "read_bytes")(tailContinuation, {
        max_bytes: 4,
      })
    ).resolves.toEqual({
      kind: "tail",
      value: {
        ok: false,
        code: 1,
        message:
          "stdin is configured for text decoding; read_bytes requires raw byte chunks",
      },
    });
  });

  it("registers fallback output handlers when stream APIs are unavailable", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "browser" },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.output")
        ?.supported
    ).toBe(true);

    await expect(
      (async () =>
        getHandler("voyd.std.output", "write")(tailContinuation, {}))()
    ).rejects.toThrow(/does not implement op write/i);
  });

  it("keeps output partially supported for write-only hooks", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
      { effectId: "voyd.std.output", opName: "write_bytes", opId: 1 },
      { effectId: "voyd.std.output", opName: "flush", opId: 2 },
      { effectId: "voyd.std.output", opName: "is_tty", opId: 3 },
    ]);
    const writes: Array<{ target: string; value: string }> = [];
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        runtimeHooks: {
          write: async ({ target, value }) => {
            writes.push({ target, value });
          },
        },
      },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.output")
        ?.supported
    ).toBe(true);

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "hello",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    await expect(
      (async () =>
        getHandler("voyd.std.output", "write_bytes")(tailContinuation, {
          bytes: [1, 2, 3],
        }))()
    ).rejects.toThrow(/does not implement op write_bytes/i);
    await expect(
      getHandler("voyd.std.output", "flush")(tailContinuation, {
        target: "stdout",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    expect(
      getHandler("voyd.std.output", "is_tty")(tailContinuation, {
        target: "stdout",
      })
    ).toEqual({
      kind: "tail",
      value: false,
    });
    expect(writes).toEqual([{ target: "stdout", value: "hello" }]);
  });

  it("keeps output partially supported for bytes-only hooks", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
      { effectId: "voyd.std.output", opName: "write_bytes", opId: 1 },
      { effectId: "voyd.std.output", opName: "flush", opId: 2 },
      { effectId: "voyd.std.output", opName: "is_tty", opId: 3 },
    ]);
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        runtimeHooks: {
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
        },
      },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.output")
        ?.supported
    ).toBe(true);

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "hello",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    await expect(
      getHandler("voyd.std.output", "write_bytes")(tailContinuation, {
        target: "stderr",
        bytes: [255, 0, 1],
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    await expect(
      getHandler("voyd.std.output", "flush")(tailContinuation, {
        target: "stdout",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    expect(
      getHandler("voyd.std.output", "is_tty")(tailContinuation, {
        target: "stdout",
      })
    ).toEqual({
      kind: "tail",
      value: false,
    });
    expect(byteWrites).toEqual([
      { target: "stdout", bytes: [104, 101, 108, 108, 111] },
      { target: "stderr", bytes: [255, 0, 1] },
    ]);
  });

  it("routes write through writeBytes hooks before node streams", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
    ]);
    const streamWrites: Array<{ target: string; value: string }> = [];
    const stdout: any = {
      isTTY: true,
      writableNeedDrain: false,
      write: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        streamWrites.push({ target: "stdout", value: String(chunk) });
        callback?.(null);
        return true;
      },
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const stderr: any = {
      isTTY: true,
      writableNeedDrain: false,
      write: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        streamWrites.push({ target: "stderr", value: String(chunk) });
        callback?.(null);
        return true;
      },
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    vi.stubGlobal("process", { stdout, stderr });
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "node",
        runtimeHooks: {
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
        },
      },
    });

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "hello",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    expect(byteWrites).toEqual([
      { target: "stdout", bytes: [104, 101, 108, 108, 111] },
    ]);
    expect(streamWrites).toEqual([]);
  });

  it("supports write and write_bytes while keeping flush and is_tty safe by default", async () => {
    const table = buildTable([
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
      { effectId: "voyd.std.output", opName: "write_bytes", opId: 1 },
      { effectId: "voyd.std.output", opName: "flush", opId: 2 },
      { effectId: "voyd.std.output", opName: "is_tty", opId: 3 },
    ]);
    const writes: Array<{ target: string; value: string }> = [];
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        runtimeHooks: {
          write: async ({ target, value }) => {
            writes.push({ target, value });
          },
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
        },
      },
    });
    expect(
      report.capabilities.find((capability) => capability.effectId === "voyd.std.output")
        ?.supported
    ).toBe(true);

    await expect(
      getHandler("voyd.std.output", "write")(tailContinuation, {
        value: "hello",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    await expect(
      getHandler("voyd.std.output", "write_bytes")(tailContinuation, {
        target: "stderr",
        bytes: [4, 5, 6],
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    await expect(
      getHandler("voyd.std.output", "flush")(tailContinuation, {
        target: "stdout",
      })
    ).resolves.toEqual({
      kind: "tail",
      value: { ok: true },
    });
    expect(
      getHandler("voyd.std.output", "is_tty")(tailContinuation, {
        target: "stdout",
      })
    ).toEqual({
      kind: "tail",
      value: false,
    });
    expect(writes).toEqual([{ target: "stdout", value: "hello" }]);
    expect(byteWrites).toEqual([{ target: "stderr", bytes: [4, 5, 6] }]);
  });

  it("chunks browser random fills to avoid WebCrypto quota errors", async () => {
    const table = buildTable([
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 0 },
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
      options: {
        runtime: "browser",
        effectBufferSize: 200_000,
      },
    });
    chunkSizes.length = 0;

    const result = await getHandler("voyd.std.random", "fill_bytes")(
      tailContinuation,
      70_000
    );
    expect(result.kind).toBe("tail");
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as unknown[]).length).toBe(70_000);
    expect(chunkSizes).toEqual([65_536, 4_464]);
  });

  it("bounds fill_bytes payloads to transport-safe size", async () => {
    const table = buildTable([
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 0 },
    ]);
    const randomBytes = vi.fn((length: number) =>
      Uint8Array.from(Array.from({ length }, () => 255))
    );
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        effectBufferSize: 64,
        runtimeHooks: { randomBytes },
      },
    });

    const result = await getHandler("voyd.std.random", "fill_bytes")(
      tailContinuation,
      100
    );
    expect(result.kind).toBe("tail");
    expect(result.value).toEqual(Array.from({ length: 30 }, () => 255));
    expect(randomBytes).toHaveBeenCalledWith(30);
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  it("accounts for array32 header overhead when bounding fill_bytes payloads", async () => {
    const table = buildTable([
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 0 },
    ]);
    const randomBytes = vi.fn((length: number) =>
      Uint8Array.from(Array.from({ length }, () => 255))
    );
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        effectBufferSize: 131_078,
        runtimeHooks: { randomBytes },
      },
    });

    const result = await getHandler("voyd.std.random", "fill_bytes")(
      tailContinuation,
      1_000_000
    );
    expect(result.kind).toBe("tail");
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as unknown[]).length).toBe(65_536);
    expect(randomBytes).toHaveBeenCalledWith(65_536);
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  it("does not consume random hook bytes during adapter registration", async () => {
    const table = buildTable([
      { effectId: "voyd.std.random", opName: "next_i64", opId: 0 },
      { effectId: "voyd.std.random", opName: "fill_bytes", opId: 1 },
    ]);
    const stream = Uint8Array.from(
      Array.from({ length: 16 }, (_, index) => index + 1)
    );
    let offset = 0;
    const randomBytes = vi.fn((length: number) => {
      const end = offset + length;
      const bytes = stream.subarray(offset, end);
      if (bytes.byteLength < length) {
        throw new Error("random hook stream exhausted");
      }
      offset = end;
      return Uint8Array.from(bytes);
    });
    const { host, getHandler } = createFakeHost(table);

    await registerDefaultHostAdapters({
      host,
      options: {
        runtime: "browser",
        runtimeHooks: { randomBytes },
      },
    });

    expect(randomBytes).not.toHaveBeenCalled();

    const nextI64Result = await getHandler("voyd.std.random", "next_i64")(
      tailContinuation
    );
    expect(nextI64Result).toEqual({
      kind: "tail",
      value: 0x0807060504030201n,
    });

    const fillBytesResult = await getHandler("voyd.std.random", "fill_bytes")(
      tailContinuation,
      4
    );
    expect(fillBytesResult).toEqual({
      kind: "tail",
      value: [9, 10, 11, 12],
    });
    expect(randomBytes).toHaveBeenCalledTimes(2);
  });

  it("returns null for denied deno env reads", async () => {
    const table = buildTable([
      { effectId: "voyd.std.env", opName: "get", opId: 0 },
      { effectId: "voyd.std.env", opName: "set", opId: 1 },
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

    const result = await getHandler("voyd.std.env", "get")(
      tailContinuation,
      "HOME"
    );
    expect(result.kind).toBe("tail");
    expect(result.value).toBeNull();
  });
});
