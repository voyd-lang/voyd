import { describe, expect, it, vi } from "vitest";
import { createRuntimeScheduler } from "./scheduler.js";

const createManualTaskQueue = () => {
  const tasks: Array<() => void> = [];
  const scheduleTask = (task: () => void): void => {
    tasks.push(task);
  };
  const drain = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      while (tasks.length > 0) {
        const task = tasks.shift();
        task?.();
      }
      await Promise.resolve();
      if (tasks.length === 0) {
        await Promise.resolve();
        if (tasks.length === 0) return;
      }
    }
    throw new Error("scheduler did not quiesce");
  };
  return { scheduleTask, drain };
};

describe("createRuntimeScheduler", () => {
  it("round-robins ready runs under a fairness budget", async () => {
    const queue = createManualTaskQueue();
    const scheduler = createRuntimeScheduler({
      maxInternalStepsPerTick: 1,
      scheduleTask: queue.scheduleTask,
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

    await queue.drain();

    expect(trace).toEqual(["a:0", "b:0", "a:1", "b:1", "a:2", "b:2"]);
    await expect(runA.outcome).resolves.toEqual({ kind: "value", value: 102 });
    await expect(runB.outcome).resolves.toEqual({ kind: "value", value: 202 });
  });

  it("cancels waiting runs and drops late completions", async () => {
    const queue = createManualTaskQueue();
    const scheduler = createRuntimeScheduler({
      scheduleTask: queue.scheduleTask,
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

    await queue.drain();

    expect(run.cancel("stop")).toBe(true);
    expect(run.cancel("stop-again")).toBe(false);
    await expect(run.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stop",
    });

    resolvePending?.({ kind: "value", value: 42 });
    await queue.drain();
    await expect(run.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stop",
    });
  });

  it("reports failures through outcome and onRunFailed callback", async () => {
    const queue = createManualTaskQueue();
    const onRunFailed = vi.fn();
    const scheduler = createRuntimeScheduler({
      scheduleTask: queue.scheduleTask,
      onRunFailed,
    });

    const run = scheduler.startRun<number>({
      start: () => 0,
      step: () => {
        throw new Error("boom");
      },
    });

    await queue.drain();

    const outcome = await run.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      throw new Error("expected failed outcome");
    }
    expect(outcome.error.message).toContain("boom");
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onRunFailed.mock.calls[0]?.[1]).toBe(run.id);
  });
});
