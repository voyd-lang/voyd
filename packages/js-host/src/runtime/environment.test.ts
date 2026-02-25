import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTaskForRuntime,
  type HostRuntimeKind,
} from "./environment.js";

describe("scheduleTaskForRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses setImmediate on node", () => {
    const trace: string[] = [];
    const setImmediateSpy = vi.fn((task: () => void) => {
      task();
      return 0;
    });
    const setTimeoutSpy = vi.fn();
    vi.stubGlobal("setImmediate", setImmediateSpy);
    vi.stubGlobal("setTimeout", setTimeoutSpy);

    const schedule = scheduleTaskForRuntime("node");
    schedule(() => {
      trace.push("ran");
    });

    expect(trace).toEqual(["ran"]);
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("uses macrotask scheduling on browser/deno/unknown", () => {
    const trace: string[] = [];
    const setTimeoutSpy = vi.fn((task: () => void, _delay?: number) => {
      task();
      return 0;
    });
    const setImmediateSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("setImmediate", setImmediateSpy);

    (["browser", "deno", "unknown"] as HostRuntimeKind[]).forEach((runtime) => {
      const schedule = scheduleTaskForRuntime(runtime);
      schedule(() => {
        trace.push(runtime);
      });
    });

    expect(trace).toEqual(["browser", "deno", "unknown"]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(setImmediateSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it("falls back to microtask when setTimeout is unavailable", async () => {
    vi.stubGlobal("setTimeout", undefined);
    const schedule = scheduleTaskForRuntime("browser");
    const trace: string[] = [];

    schedule(() => {
      trace.push("scheduled");
    });
    trace.push("sync");
    await Promise.resolve();

    expect(trace).toEqual(["sync", "scheduled"]);
  });
});
