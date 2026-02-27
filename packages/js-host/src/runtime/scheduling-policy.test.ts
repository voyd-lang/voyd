import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTaskForRuntimePolicy,
  type RuntimeSchedulingKind,
} from "./scheduling-policy.js";

describe("scheduleTaskForRuntimePolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers setImmediate on node", () => {
    const trace: string[] = [];
    const setImmediateSpy = vi.fn((task: () => void) => {
      task();
      return 0;
    });
    const setTimeoutSpy = vi.fn();
    vi.stubGlobal("setImmediate", setImmediateSpy);
    vi.stubGlobal("setTimeout", setTimeoutSpy);

    const schedule = scheduleTaskForRuntimePolicy("node");
    schedule(() => {
      trace.push("ran");
    });

    expect(trace).toEqual(["ran"]);
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("uses setTimeout on non-node runtimes", () => {
    const trace: string[] = [];
    const setTimeoutSpy = vi.fn((task: () => void, _delay?: number) => {
      task();
      return 0;
    });
    const setImmediateSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("setImmediate", setImmediateSpy);

    (["browser", "deno", "unknown"] as RuntimeSchedulingKind[]).forEach(
      (runtime) => {
        const schedule = scheduleTaskForRuntimePolicy(runtime);
        schedule(() => {
          trace.push(runtime);
        });
      }
    );

    expect(trace).toEqual(["browser", "deno", "unknown"]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(setImmediateSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it("falls back to microtasks when macrotask APIs are unavailable", async () => {
    vi.stubGlobal("setImmediate", undefined);
    vi.stubGlobal("setTimeout", undefined);
    const queueMicrotaskSpy = vi.fn((task: () => void) => {
      task();
    });
    vi.stubGlobal("queueMicrotask", queueMicrotaskSpy);

    const trace: string[] = [];
    const schedule = scheduleTaskForRuntimePolicy("node");
    schedule(() => {
      trace.push("scheduled");
    });
    trace.push("sync");
    await Promise.resolve();

    expect(trace).toEqual(["scheduled", "sync"]);
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1);
  });
});
