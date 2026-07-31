import { describe, expect, it } from "vitest";
import {
  parsePartitionArgs,
  partitionsForArgs,
} from "./run-web-test-shards.mjs";

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
