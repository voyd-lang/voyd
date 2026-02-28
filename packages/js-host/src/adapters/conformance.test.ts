import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
} from "../protocol/types.js";
import { createDeterministicRuntime } from "../runtime/deterministic-runtime.js";
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
  return {
    host,
    getHandler: (effectId: string, opName: string): EffectHandler => {
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
    },
  };
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

const invokeHandler = (
  handler: EffectHandler,
  ...args: unknown[]
): Promise<EffectContinuationCall> =>
  Promise.resolve().then(() => handler(tailContinuation, ...args));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["node", "deno", "browser", "unknown"] as const)(
  "default adapter conformance (%s)",
  (runtimeKind) => {
    it("keeps timer/random behavior deterministic and validates fetch/input/output contracts", async () => {
      const table = buildTable([
        { effectId: "voyd.std.time", opName: "monotonic_now_millis", opId: 0 },
        { effectId: "voyd.std.time", opName: "system_now_millis", opId: 1 },
        { effectId: "voyd.std.time", opName: "sleep_millis", opId: 2 },
        { effectId: "voyd.std.time", opName: "set_timeout_millis", opId: 3 },
        { effectId: "voyd.std.time", opName: "set_interval_millis", opId: 4 },
        { effectId: "voyd.std.time", opName: "clear_timer", opId: 5 },
        { effectId: "voyd.std.random", opName: "next_i64", opId: 0 },
        { effectId: "voyd.std.random", opName: "fill_bytes", opId: 1 },
        { effectId: "voyd.std.fetch", opName: "request", opId: 0 },
        { effectId: "voyd.std.input", opName: "read_line", opId: 0 },
        { effectId: "voyd.std.input", opName: "read_bytes", opId: 1 },
        { effectId: "voyd.std.input", opName: "is_tty", opId: 2 },
        { effectId: "voyd.std.output", opName: "write", opId: 0 },
        { effectId: "voyd.std.output", opName: "write_bytes", opId: 1 },
        { effectId: "voyd.std.output", opName: "flush", opId: 2 },
        { effectId: "voyd.std.output", opName: "is_tty", opId: 3 },
      ]);
      const runtime = createDeterministicRuntime({
        startMonotonicMs: 10,
        startSystemMs: 1_000,
      });
      const { host, getHandler } = createFakeHost(table);
      const seenFetchRequests: Array<{
        method: string;
        url: string;
        body?: string;
        timeoutMillis?: number;
      }> = [];
      const seenWrites: Array<{ target: string; value: string }> = [];
      const seenByteWrites: Array<{ target: string; bytes: number[] }> = [];
      const seenFlushTargets: string[] = [];
      const seenClearedTimerIds: bigint[] = [];

      const report = await registerDefaultHostAdapters({
        host,
        options: {
          runtime: runtimeKind,
          runtimeHooks: {
            monotonicNowMillis: runtime.monotonicNowMillis,
            systemNowMillis: runtime.systemNowMillis,
            sleepMillis: runtime.sleepMillis,
            clearTimer: (timerId) => {
              seenClearedTimerIds.push(timerId);
            },
            randomBytes: (length) =>
              Uint8Array.from(
                Array.from({ length }, (_, index) => (index + 1) % 256)
              ),
            fetchRequest: async (request) => {
              seenFetchRequests.push(request);
              if (request.url.endsWith("/timeout")) {
                const error = new Error("deadline exceeded");
                error.name = "AbortError";
                throw error;
              }
              return {
                status: 200,
                statusText: "OK",
                headers: [{ name: "content-type", value: "text/plain" }],
                body: request.url.endsWith("/echo")
                  ? request.body ?? ""
                  : "voyd",
              };
            },
            readLine: async (prompt) => {
              if (prompt === "fail") {
                throw new Error("input device failure");
              }
              return prompt === "eof" ? null : "voyd";
            },
            readBytes: async (maxBytes) => {
              if (maxBytes === 99) {
                throw new Error("input bytes failure");
              }
              return maxBytes === 0 ? null : Uint8Array.from([7, 8, 9]);
            },
            isInputTty: () => true,
            write: async ({ target, value }) => {
              if (value === "fail") {
                throw new Error("output write failure");
              }
              seenWrites.push({ target, value });
            },
            writeBytes: async ({ target, bytes }) => {
              seenByteWrites.push({ target, bytes: Array.from(bytes.values()) });
            },
            flush: async ({ target }) => {
              seenFlushTargets.push(target);
            },
            isOutputTty: (target) => target === "stdout",
          },
        },
      });

      const capabilitiesByEffect = new Map(
        report.capabilities.map((capability) => [capability.effectId, capability])
      );
      expect(capabilitiesByEffect.get("voyd.std.time")?.supported).toBe(true);
      expect(capabilitiesByEffect.get("voyd.std.random")?.supported).toBe(
        true
      );
      expect(capabilitiesByEffect.get("voyd.std.fetch")?.supported).toBe(
        true
      );
      expect(capabilitiesByEffect.get("voyd.std.input")?.supported).toBe(
        true
      );
      expect(capabilitiesByEffect.get("voyd.std.output")?.supported).toBe(
        true
      );

      const monotonicHandler = getHandler(
        "voyd.std.time",
        "monotonic_now_millis"
      );
      const systemHandler = getHandler("voyd.std.time", "system_now_millis");
      const sleepHandler = getHandler("voyd.std.time", "sleep_millis");
      const timeoutHandler = getHandler("voyd.std.time", "set_timeout_millis");
      const intervalHandler = getHandler("voyd.std.time", "set_interval_millis");
      const clearTimerHandler = getHandler("voyd.std.time", "clear_timer");
      const nextI64Handler = getHandler("voyd.std.random", "next_i64");
      const fillBytesHandler = getHandler("voyd.std.random", "fill_bytes");

      await expect(invokeHandler(monotonicHandler)).resolves.toEqual({
        kind: "tail",
        value: 10n,
      });
      await expect(invokeHandler(systemHandler)).resolves.toEqual({
        kind: "tail",
        value: 1_000n,
      });

      let sleepSettled = false;
      const sleepResult = invokeHandler(sleepHandler, 5n).then((result) => {
        sleepSettled = true;
        return result;
      });
      await runtime.runUntilIdle();
      expect(sleepSettled).toBe(false);

      await runtime.advanceBy(4);
      expect(sleepSettled).toBe(false);

      await runtime.advanceBy(1);
      await expect(sleepResult).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });

      let timeoutSettled = false;
      const timeoutResult = invokeHandler(timeoutHandler, 2n).then((result) => {
        timeoutSettled = true;
        return result;
      });
      await runtime.runUntilIdle();
      expect(timeoutSettled).toBe(false);
      await runtime.advanceBy(2);
      await expect(timeoutResult).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });

      await expect(invokeHandler(intervalHandler, 3n)).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: 1n },
      });
      await expect(invokeHandler(clearTimerHandler, 1n)).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });
      expect(seenClearedTimerIds).toEqual([1n]);
      expect(runtime.pendingTimerCount()).toBe(0);

      await expect(invokeHandler(monotonicHandler)).resolves.toEqual({
        kind: "tail",
        value: 17n,
      });
      await expect(invokeHandler(systemHandler)).resolves.toEqual({
        kind: "tail",
        value: 1_007n,
      });

      await expect(invokeHandler(nextI64Handler)).resolves.toEqual({
        kind: "tail",
        value: 0x0807060504030201n,
      });
      await expect(invokeHandler(fillBytesHandler, 4)).resolves.toEqual({
        kind: "tail",
        value: [1, 2, 3, 4],
      });

      const fetchHandler = getHandler("voyd.std.fetch", "request");
      const inputLineHandler = getHandler("voyd.std.input", "read_line");
      const inputReadBytesHandler = getHandler("voyd.std.input", "read_bytes");
      const inputTtyHandler = getHandler("voyd.std.input", "is_tty");
      const outputWriteHandler = getHandler("voyd.std.output", "write");
      const outputWriteBytesHandler = getHandler("voyd.std.output", "write_bytes");
      const outputFlushHandler = getHandler("voyd.std.output", "flush");
      const outputTtyHandler = getHandler("voyd.std.output", "is_tty");

      await expect(
        invokeHandler(fetchHandler, {
          method: "post",
          url: "https://example.test/echo",
          headers: [{ name: "accept", value: "text/plain" }],
          body: "hello",
          timeout_millis: 25,
        })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: true,
          value: {
            status: 200,
            status_text: "OK",
            headers: [{ name: "content-type", value: "text/plain" }],
            body: "hello",
          },
        },
      });
      expect(seenFetchRequests).toEqual([
        {
          method: "POST",
          url: "https://example.test/echo",
          headers: [{ name: "accept", value: "text/plain" }],
          body: "hello",
          timeoutMillis: 25,
        },
      ]);

      await expect(
        invokeHandler(fetchHandler, {
          method: "GET",
          url: "https://example.test/timeout",
          headers: [],
        })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: false,
          code: 2,
          message: "fetch request timed out or was aborted",
        },
      });

      await expect(
        invokeHandler(inputLineHandler, { prompt: "Name: " })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: "voyd" },
      });

      await expect(
        invokeHandler(inputLineHandler, { prompt: "eof" })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: null },
      });

      await expect(
        invokeHandler(inputLineHandler, { prompt: "fail" })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: false,
          code: 1,
          message: "input device failure",
        },
      });

      await expect(
        invokeHandler(inputReadBytesHandler, { max_bytes: 8 })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: [7, 8, 9] },
      });

      await expect(
        invokeHandler(inputReadBytesHandler, { max_bytes: 0 })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: null },
      });

      await expect(
        invokeHandler(inputReadBytesHandler, { max_bytes: 99 })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: false,
          code: 1,
          message: "input bytes failure",
        },
      });

      await expect(invokeHandler(inputTtyHandler)).resolves.toEqual({
        kind: "tail",
        value: true,
      });

      await expect(
        invokeHandler(outputWriteHandler, {
          value: "hello",
        })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });

      await expect(
        invokeHandler(outputWriteHandler, {
          value: "fail",
        })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: false,
          code: 1,
          message: "output write failure",
        },
      });

      await expect(
        invokeHandler(outputWriteBytesHandler, {
          target: "stderr",
          bytes: [9, 10],
        })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });

      await expect(
        invokeHandler(outputFlushHandler, { target: "stderr" })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true },
      });

      await expect(
        invokeHandler(outputTtyHandler, { target: "stdout" })
      ).resolves.toEqual({
        kind: "tail",
        value: true,
      });

      await expect(
        invokeHandler(outputTtyHandler, { target: "stderr" })
      ).resolves.toEqual({
        kind: "tail",
        value: false,
      });

      expect(seenWrites).toEqual([{ target: "stdout", value: "hello" }]);
      expect(seenByteWrites).toEqual([{ target: "stderr", bytes: [9, 10] }]);
      expect(seenFlushTargets).toEqual(["stderr"]);
    });
  }
);

describe("default adapter conformance (unsupported capabilities)", () => {
  it("keeps input/output partially supported with per-op fallbacks when runtime APIs are missing", async () => {
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("prompt", undefined);
    const table = buildTable([
      { effectId: "voyd.std.fetch", opName: "request", opId: 0 },
      { effectId: "voyd.std.input", opName: "read_line", opId: 0 },
      { effectId: "voyd.std.output", opName: "write", opId: 0 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "unknown" },
    });
    const capabilitiesByEffect = new Map(
      report.capabilities.map((capability) => [capability.effectId, capability])
    );
    expect(capabilitiesByEffect.get("voyd.std.fetch")?.supported).toBe(
      false
    );
    expect(capabilitiesByEffect.get("voyd.std.input")?.supported).toBe(true);
    expect(capabilitiesByEffect.get("voyd.std.output")?.supported).toBe(true);

    await expect(
      invokeHandler(getHandler("voyd.std.fetch", "request"), {})
    ).rejects.toThrow(/default fetch adapter is unavailable/i);
    await expect(
      invokeHandler(getHandler("voyd.std.input", "read_line"), {})
    ).rejects.toThrow(/does not implement op read_line/i);
    await expect(
      invokeHandler(getHandler("voyd.std.output", "write"), {})
    ).rejects.toThrow(/does not implement op write/i);
  });
});
