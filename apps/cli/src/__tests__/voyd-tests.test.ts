import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  it("runs hidden tests within each nested source package", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "voyd-cli-packaged-tests-"),
    );
    const srcRoot = join(projectRoot, "src");
    const firstPackage = join(srcRoot, "first");
    const secondPackage = join(srcRoot, "second");

    try {
      await Promise.all([
        mkdir(firstPackage, { recursive: true }),
        mkdir(secondPackage, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(firstPackage, "pkg.voyd"),
          'pub fn value() -> i32\n  1\n\ntest "skips at first package root":\n  1\n',
        ),
        writeFile(
          join(firstPackage, "hidden.voyd"),
          'test only "runs inside first package":\n  1\n',
        ),
        writeFile(
          join(secondPackage, "pkg.voyd"),
          "pub fn value() -> i32\n  2\n",
        ),
        writeFile(
          join(secondPackage, "hidden.voyd"),
          'test "skips inside second package":\n  1\n',
        ),
        writeFile(
          join(srcRoot, "root_test.voyd"),
          'test "skips at source root":\n  1\n',
        ),
      ]);

      const result = await runTests({ rootPath: srcRoot, reporter: "silent" });

      expect(result.total).toBe(4);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(3);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
