import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePartitionArgs,
  partitionsForArgs,
} from "./run-web-test-shards.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const webTestModules = globSync("**/*.test.voyd", {
  cwd: resolve(repoRoot, "packages/web/src"),
}).sort();
const packageScripts = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).scripts;
const webPackageScripts = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/web/package.json"), "utf8"),
).scripts;
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/pr.yml"),
  "utf8",
);
const ciPartitionCommands = ["test:unit:web:ci"];
const ciPartitions = ciPartitionCommands.map((command) => {
  const match = /--partition-index=(\d+) --partition-count=(\d+)/.exec(
    packageScripts[command],
  );
  if (!match) throw new Error(`Missing partition script for ${command}`);
  return {
    command,
    index: Number(match[1]),
    count: Number(match[2]),
  };
});
const modulesForPartition = (modules, partition) =>
  modules.filter(
    (_module, index) => index % partition.count === partition.index,
  );

describe("web test shard partitioning", () => {
  it("runs one combined compile by default locally", () => {
    expect(partitionsForArgs([])).toEqual([{ index: 0, count: 1 }]);
  });

  it("retains eight sequential partitions as an isolation fallback", () => {
    expect(partitionsForArgs(["--isolated"])).toEqual(
      Array.from({ length: 8 }, (_value, index) => ({ index, count: 8 })),
    );
    expect(webPackageScripts["test:isolated"]).toContain("--isolated");
  });

  it("runs only the requested CI partition", () => {
    expect(
      partitionsForArgs(["--partition-index=6", "--partition-count=8"]),
    ).toEqual([{ index: 6, count: 8 }]);
  });

  it("assigns all current Web test modules to one CI compile", () => {
    const assignments = ciPartitions.flatMap((partition) =>
      modulesForPartition(webTestModules, partition).map((module) => ({
        module,
        command: partition.command,
      })),
    );

    expect(assignments.map(({ module }) => module).sort()).toEqual(
      webTestModules,
    );
    expect(new Set(assignments.map(({ module }) => module))).toHaveLength(24);
    expect(ciPartitions).toEqual([
      {
        command: "test:unit:web:ci",
        index: 0,
        count: 1,
      },
    ]);
    expect(workflow).toContain("-- npm run test:unit:web:ci");
  });

  it.each([
    [["--partition-index=0"], "requires"],
    [["--partition-index=0", "--unknown=2"], "Unknown"],
    [["--partition-index=0", "--partition-count=0"], "positive integer"],
    [["--partition-index=2", "--partition-count=2"], "from zero"],
    [["--partition-index=one", "--partition-count=2"], "from zero"],
  ])("rejects invalid partition arguments", (args, message) => {
    expect(() => parsePartitionArgs(args)).toThrow(message);
  });
});
