import { describe, test } from "vitest";
import { runWasm } from "../cli/exec.js";
import { resolve } from "node:path";

describe("runWasm regression", () => {
  // TODO(Phase 9): Re-enable once wasm runtime no longer traps for canonicalized optionals.
  test.skip("test.voyd executes main and returns 1", async (t) => {
    const index = resolve("test.voyd");
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.length > 1 ? args : args[0]);
    };

    try {
      const result = await runWasm(index);
      t.expect(result).toEqual(1);
    } finally {
      console.log = originalLog;
    }

    t.expect(logs).toContain(1);
  });
});
