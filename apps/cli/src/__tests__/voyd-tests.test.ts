import { describe, expect, it } from "vitest";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { runTests } from "../test-runner.js";

describe("voyd test runner", () => {
  it("runs std optional tests", async () => {
    const result = await runTests({
      rootPath: resolveStdRoot(),
      reporter: "silent",
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });
});
