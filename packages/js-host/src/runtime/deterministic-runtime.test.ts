import { describe, expect, it } from "vitest";
import { createDeterministicRuntime } from "./deterministic-runtime.js";

describe("createDeterministicRuntime", () => {
  it("drains queued tasks in FIFO order", async () => {
    const runtime = createDeterministicRuntime();
    const trace: string[] = [];

    runtime.scheduleTask(() => {
      trace.push("a");
    });
    runtime.scheduleTask(() => {
      trace.push("b");
    });

    await runtime.runUntilIdle();
    expect(trace).toEqual(["a", "b"]);
  });

  it("advances timers deterministically", async () => {
    const runtime = createDeterministicRuntime({
      startMonotonicMs: 100,
      startSystemMs: 1_000,
    });
    const trace: string[] = [];

    const slow = runtime.sleepMillis(10).then(() => {
      trace.push("slow");
    });
    const fast = runtime.sleepMillis(3).then(() => {
      trace.push("fast");
    });

    await runtime.runUntilIdle();
    expect(trace).toEqual([]);

    await runtime.advanceBy(3);
    expect(trace).toEqual(["fast"]);
    expect(runtime.monotonicNowMillis()).toBe(103n);
    expect(runtime.systemNowMillis()).toBe(1_003n);

    await runtime.advanceBy(7);
    expect(trace).toEqual(["fast", "slow"]);
    await Promise.all([fast, slow]);
  });
});
