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
    it("keeps timer/random behavior deterministic and validates fetch/input contracts", async () => {
      const table = buildTable([
        { effectId: "std::time::Time", opName: "monotonic_now_millis", opId: 0 },
        { effectId: "std::time::Time", opName: "system_now_millis", opId: 1 },
        { effectId: "std::time::Time", opName: "sleep_millis", opId: 2 },
        { effectId: "std::random::Random", opName: "next_i64", opId: 0 },
        { effectId: "std::random::Random", opName: "fill_bytes", opId: 1 },
        { effectId: "std::fetch::Fetch", opName: "request", opId: 0 },
        { effectId: "std::input::Input", opName: "read_line", opId: 0 },
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

      const report = await registerDefaultHostAdapters({
        host,
        options: {
          runtime: runtimeKind,
          runtimeHooks: {
            monotonicNowMillis: runtime.monotonicNowMillis,
            systemNowMillis: runtime.systemNowMillis,
            sleepMillis: runtime.sleepMillis,
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
          },
        },
      });

      const capabilitiesByEffect = new Map(
        report.capabilities.map((capability) => [capability.effectId, capability])
      );
      expect(capabilitiesByEffect.get("std::time::Time")?.supported).toBe(true);
      expect(capabilitiesByEffect.get("std::random::Random")?.supported).toBe(
        true
      );
      expect(capabilitiesByEffect.get("std::fetch::Fetch")?.supported).toBe(
        true
      );
      expect(capabilitiesByEffect.get("std::input::Input")?.supported).toBe(
        true
      );

      const monotonicHandler = getHandler(
        "std::time::Time",
        "monotonic_now_millis"
      );
      const systemHandler = getHandler("std::time::Time", "system_now_millis");
      const sleepHandler = getHandler("std::time::Time", "sleep_millis");
      const nextI64Handler = getHandler("std::random::Random", "next_i64");
      const fillBytesHandler = getHandler("std::random::Random", "fill_bytes");

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

      await expect(invokeHandler(monotonicHandler)).resolves.toEqual({
        kind: "tail",
        value: 15n,
      });
      await expect(invokeHandler(systemHandler)).resolves.toEqual({
        kind: "tail",
        value: 1_005n,
      });

      await expect(invokeHandler(nextI64Handler)).resolves.toEqual({
        kind: "tail",
        value: 0x0807060504030201n,
      });
      await expect(invokeHandler(fillBytesHandler, 4)).resolves.toEqual({
        kind: "tail",
        value: [1, 2, 3, 4],
      });

      const fetchHandler = getHandler("std::fetch::Fetch", "request");
      const inputHandler = getHandler("std::input::Input", "read_line");

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
        invokeHandler(inputHandler, { prompt: "Name: " })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: "voyd" },
      });

      await expect(
        invokeHandler(inputHandler, { prompt: "eof" })
      ).resolves.toEqual({
        kind: "tail",
        value: { ok: true, value: null },
      });

      await expect(
        invokeHandler(inputHandler, { prompt: "fail" })
      ).resolves.toEqual({
        kind: "tail",
        value: {
          ok: false,
          code: 1,
          message: "input device failure",
        },
      });
    });
  }
);

describe("default adapter conformance (unsupported capabilities)", () => {
  it("marks fetch/input unsupported when no runtime implementation exists", async () => {
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("prompt", undefined);
    const table = buildTable([
      { effectId: "std::fetch::Fetch", opName: "request", opId: 0 },
      { effectId: "std::input::Input", opName: "read_line", opId: 0 },
    ]);
    const { host, getHandler } = createFakeHost(table);

    const report = await registerDefaultHostAdapters({
      host,
      options: { runtime: "unknown" },
    });
    const capabilitiesByEffect = new Map(
      report.capabilities.map((capability) => [capability.effectId, capability])
    );
    expect(capabilitiesByEffect.get("std::fetch::Fetch")?.supported).toBe(
      false
    );
    expect(capabilitiesByEffect.get("std::input::Input")?.supported).toBe(
      false
    );

    await expect(
      invokeHandler(getHandler("std::fetch::Fetch", "request"), {})
    ).rejects.toThrow(/default fetch adapter is unavailable/i);
    await expect(
      invokeHandler(getHandler("std::input::Input", "read_line"), {})
    ).rejects.toThrow(/default input adapter is unavailable/i);
  });
});
