import { describe, expect, it, vi } from "vitest";
import { DiagnosticsScheduler } from "../server/diagnostics-scheduler.js";

describe("diagnostics scheduler", () => {
  it("debounces publishes and runs only the latest schedule", async () => {
    vi.useFakeTimers();
    const scheduler = new DiagnosticsScheduler();
    const calls: string[] = [];

    scheduler.schedule({
      delayMs: 40,
      publish: () => {
        calls.push("first");
      },
    });
    scheduler.schedule({
      delayMs: 40,
      publish: () => {
        calls.push("second");
      },
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["second"]);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("marks a run stale after a newer schedule", async () => {
    vi.useFakeTimers();
    const scheduler = new DiagnosticsScheduler();
    let beforeReschedule = false;
    let afterReschedule = true;

    scheduler.schedule({
      delayMs: 0,
      publish: (run) => {
        beforeReschedule = run.isCurrent();
        scheduler.schedule({
          delayMs: 20,
          publish: () => undefined,
        });
        afterReschedule = run.isCurrent();
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(beforeReschedule).toBe(true);
    expect(afterReschedule).toBe(false);

    scheduler.dispose();
    vi.useRealTimers();
  });
});
