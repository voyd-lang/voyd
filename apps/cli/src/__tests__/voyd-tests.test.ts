import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTests, selectTestShard } from "../test-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skipFixturePath = resolve(__dirname, "fixtures", "skip-effect.voyd");
const onlyFixturePath = resolve(__dirname, "fixtures", "global-only");

describe("voyd test runner", { timeout: 240_000 }, () => {
  it("assigns sorted test modules exactly once across shards", () => {
    const files = Array.from(
      { length: 28 },
      (_value, index) => `test-${String(27 - index).padStart(2, "0")}.voyd`,
    );
    const shards = Array.from({ length: 8 }, (_value, index) =>
      selectTestShard(files, { index, count: 8 }),
    );

    expect(shards.map((shard) => shard.length)).toEqual([
      4, 4, 4, 4, 3, 3, 3, 3,
    ]);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(new Set(shards.flat()).size).toBe(files.length);
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
