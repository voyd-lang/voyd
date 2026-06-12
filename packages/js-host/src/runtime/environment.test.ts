import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectHostRuntime,
  scheduleTaskForRuntime,
  type HostRuntimeKind,
} from "./environment.js";
import { scheduleTaskForRuntimePolicy } from "./scheduling-policy.js";

describe("scheduleTaskForRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to the shared scheduling policy helper", () => {
    expect(scheduleTaskForRuntime("node")).toBe(
      scheduleTaskForRuntimePolicy("node")
    );
    expect(scheduleTaskForRuntime("unknown")).toBe(
      scheduleTaskForRuntimePolicy("unknown")
    );
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

  it("uses macrotask scheduling on browser/deno/bun/unknown", () => {
    const trace: string[] = [];
    const setTimeoutSpy = vi.fn((task: () => void, _delay?: number) => {
      task();
      return 0;
    });
    const setImmediateSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("setImmediate", setImmediateSpy);

    (["browser", "deno", "bun", "unknown"] as HostRuntimeKind[]).forEach((runtime) => {
      const schedule = scheduleTaskForRuntime(runtime);
      schedule(() => {
        trace.push(runtime);
      });
    });

    expect(trace).toEqual(["browser", "deno", "bun", "unknown"]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(4);
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

  it("detects bun before node-compatible process globals", () => {
    vi.stubGlobal("Bun", { version: "1.0.0" });
    vi.stubGlobal("process", { versions: { node: "20.0.0", bun: "1.0.0" } });

    expect(detectHostRuntime()).toBe("bun");
  });
});
