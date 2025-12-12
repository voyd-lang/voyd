import { describe, expect, it } from "vitest";

import { createTailResumptionGuard } from "../resumptions.js";

describe("tail resumption guard", () => {
  it("throws when the tail continuation is never resumed", () => {
    const guard = createTailResumptionGuard({
      resume: () => undefined,
    });
    expect(guard.callCount()).toBe(0);
    expect(() => guard.finalize()).toThrow(/resumed exactly once/i);
  });

  it("throws when the tail continuation is resumed multiple times", () => {
    const guard = createTailResumptionGuard({
      resume: () => undefined,
    });
    guard.resume(undefined);
    expect(() => guard.resume(undefined)).toThrow(/resumed exactly once/i);
  });

  it("allows forwarding when a single resume happens elsewhere", () => {
    const guard = createTailResumptionGuard({
      resume: (value: number) => value + 1,
    });

    const forward = (fn: (value: number) => number): number => fn(41);
    const result = forward(guard.resume);

    guard.finalize();
    expect(result).toBe(42);
    expect(guard.callCount()).toBe(1);
  });

  it("catches missing resumes after forwarding", () => {
    const guard = createTailResumptionGuard({
      resume: (value: number) => value,
    });

    const drop = (_fn: (value: number) => number): void => undefined;
    drop(guard.resume);

    expect(() => guard.finalize()).toThrow(/observed 0/);
  });
});
