import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { runTests } from "../test-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skipFixturePath = resolve(__dirname, "fixtures", "skip-effect.voyd");
const onlyFixturePath = resolve(__dirname, "fixtures", "global-only");

describe("voyd test runner", { timeout: 60_000 }, () => {
  it("runs std optional tests", async () => {
    const result = await runTests({
      rootPath: resolveStdRoot(),
      reporter: "silent",
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  it("handles Test.skip from effectful tests", async () => {
    const result = await runTests({
      rootPath: skipFixturePath,
      reporter: "silent",
    });

    expect(result.total).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("respects global only across modules", async () => {
    const result = await runTests({
      rootPath: onlyFixturePath,
      reporter: "silent",
    });

    expect(result.total).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
  });
});
