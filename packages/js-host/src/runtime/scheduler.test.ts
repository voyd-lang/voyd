import { describe, expect, it, vi } from "vitest";
import { createDeterministicRuntime } from "./deterministic-runtime.js";
import { createRuntimeScheduler } from "./scheduler.js";

describe("createRuntimeScheduler", () => {
  it("round-robins ready runs under a fairness budget", async () => {
    const runtime = createDeterministicRuntime();
    const scheduler = createRuntimeScheduler({
      maxInternalStepsPerTick: 1,
      scheduleTask: runtime.scheduleTask,
    });
    const trace: string[] = [];

    const runA = scheduler.startRun<number>({
      start: () => 0,
      step: (state) => {
        const value = state as number;
        trace.push(`a:${value}`);
        return value >= 2
          ? { kind: "value", value: 100 + value }
          : { kind: "next", result: value + 1 };
      },
    });
    const runB = scheduler.startRun<number>({
      start: () => 0,
      step: (state) => {
        const value = state as number;
        trace.push(`b:${value}`);
        return value >= 2
          ? { kind: "value", value: 200 + value }
          : { kind: "next", result: value + 1 };
      },
    });

    await runtime.runUntilIdle();

    expect(trace).toEqual(["a:0", "b:0", "a:1", "b:1", "a:2", "b:2"]);
    await expect(runA.outcome).resolves.toEqual({ kind: "value", value: 102 });
    await expect(runB.outcome).resolves.toEqual({ kind: "value", value: 202 });
  });

  it("cancels waiting runs and drops late completions", async () => {
    const runtime = createDeterministicRuntime();
    const scheduler = createRuntimeScheduler({
      scheduleTask: runtime.scheduleTask,
    });
    let resolvePending:
      | ((value: { kind: "value"; value: number }) => void)
      | undefined;

    const run = scheduler.startRun<number>({
      start: () => 0,
      step: () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    });

    await runtime.runUntilIdle();

    expect(run.cancel("stop")).toBe(true);
    expect(run.cancel("stop-again")).toBe(false);
    await expect(run.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stop",
    });

    resolvePending?.({ kind: "value", value: 42 });
    await runtime.runUntilIdle();
    await expect(run.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stop",
    });
  });

  it("exposes cancellation state to in-flight steps", async () => {
    const runtime = createDeterministicRuntime();
    const scheduler = createRuntimeScheduler({
      scheduleTask: runtime.scheduleTask,
    });
    let resolvePending:
      | ((result: { kind: "aborted" } | { kind: "value"; value: number }) => void)
      | undefined;
    let sawCancelled = false;

    const run = scheduler.startRun<number>({
      start: () => 0,
      step: (_state, context) =>
        new Promise((resolve) => {
          resolvePending = (result) => {
            sawCancelled = context.isCancelled();
            resolve(result);
          };
        }),
    });

    await runtime.runUntilIdle();

    expect(run.cancel("stop")).toBe(true);
    resolvePending?.({ kind: "aborted" });
    await runtime.runUntilIdle();

    expect(sawCancelled).toBe(true);
    await expect(run.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stop",
    });
  });

  it("reports failures through outcome and onRunFailed callback", async () => {
    const runtime = createDeterministicRuntime();
    const onRunFailed = vi.fn();
    const scheduler = createRuntimeScheduler({
      scheduleTask: runtime.scheduleTask,
      onRunFailed,
    });

    const run = scheduler.startRun<number>({
      start: () => 0,
      step: () => {
        throw new Error("boom");
      },
    });

    await runtime.runUntilIdle();

    const outcome = await run.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      throw new Error("expected failed outcome");
    }
    expect(outcome.error.message).toContain("boom");
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onRunFailed.mock.calls[0]?.[1]).toBe(run.id);
  });

  it("does not run timers unless virtual time advances", async () => {
    const runtime = createDeterministicRuntime();
    const scheduler = createRuntimeScheduler({
      scheduleTask: runtime.scheduleTask,
    });
    let finished = false;

    const run = scheduler.startRun<number>({
      start: () => 0,
      step: async () => {
        await runtime.sleepMillis(5);
        finished = true;
        return { kind: "value", value: 42 };
      },
    });

    await runtime.runUntilIdle();
    expect(finished).toBe(false);

    await runtime.advanceBy(4);
    expect(finished).toBe(false);

    await runtime.advanceBy(1);
    expect(finished).toBe(true);
    await expect(run.outcome).resolves.toEqual({ kind: "value", value: 42 });
  });
});
