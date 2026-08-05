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
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/pr.yml"),
  "utf8",
);
const ciPartitionCommands = [
  "test:unit:web:ci:0a",
  "test:unit:web:ci:0b",
  "test:unit:web:ci:0c",
  "test:unit:web:ci:1",
  "test:unit:web:ci:2",
  "test:unit:web:ci:3",
  "test:unit:web:ci:4a",
  "test:unit:web:ci:4b",
  "test:unit:web:ci:4c",
  "test:unit:web:ci:5",
  "test:unit:web:ci:6",
  "test:unit:web:ci:7",
];
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
  it("runs eight compile-level partitions for local and full-suite tests", () => {
    expect(partitionsForArgs([])).toEqual(
      Array.from({ length: 8 }, (_value, index) => ({ index, count: 8 })),
    );
  });

  it("runs only the requested CI partition", () => {
    expect(
      partitionsForArgs([
        "--partition-index=6",
        "--partition-count=8",
      ]),
    ).toEqual([{ index: 6, count: 8 }]);
  });

  it("assigns all current Web test modules exactly once in CI", () => {
    const assignments = ciPartitions.flatMap((partition) =>
      modulesForPartition(webTestModules, partition).map((module) => ({
        module,
        command: partition.command,
      })),
    );

    expect(assignments.map(({ module }) => module).sort()).toEqual(
      webTestModules,
    );
    expect(new Set(assignments.map(({ module }) => module))).toHaveLength(28);
    expect(
      Array.from(workflow.matchAll(/command: npm run (test:unit:web:ci:\S+)/g),
        (match) => match[1],
      ),
    ).toEqual(ciPartitionCommands);
  });

  it("isolates the four OpenAPI test modules that exceeded the process timeout", () => {
    const assignments = new Map(
      ciPartitions.flatMap((partition) =>
        modulesForPartition(webTestModules, partition).map((module) => [
          module,
          partition.command,
        ]),
      ),
    );

    expect(assignments.get("openapi/openapi_app.test.voyd")).toBe(
      "test:unit:web:ci:0a",
    );
    expect(
      assignments.get("openapi/openapi_response_contracts.test.voyd"),
    ).toBe(
      "test:unit:web:ci:0c",
    );
    expect(assignments.get("openapi/openapi_builder_query.test.voyd")).toBe(
      "test:unit:web:ci:4a",
    );
    expect(
      assignments.get("openapi/openapi_response_overrides.test.voyd"),
    ).toBe(
      "test:unit:web:ci:4c",
    );
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
