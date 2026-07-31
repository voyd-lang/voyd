import { describe, expect, it } from "vitest";
import { parsePartitionArgs, selectPartition } from "./run-web-test-shards.mjs";

describe("web test shard partitioning", () => {
  it("runs every sorted file when partitioning is absent", () => {
    const files = ["a.test.voyd", "b.test.voyd", "c.test.voyd"];
    expect(selectPartition(files, parsePartitionArgs([]))).toEqual(files);
  });

  it("assigns every file exactly once across deterministic partitions", () => {
    const files = [
      "a.test.voyd",
      "b.test.voyd",
      "c.test.voyd",
      "d.test.voyd",
      "e.test.voyd",
    ];
    const first = selectPartition(
      files,
      parsePartitionArgs(["--partition-index=0", "--partition-count=3"]),
    );
    const second = selectPartition(
      files,
      parsePartitionArgs(["--partition-index=1", "--partition-count=3"]),
    );
    const third = selectPartition(
      files,
      parsePartitionArgs(["--partition-index=2", "--partition-count=3"]),
    );

    expect(first).toEqual(["a.test.voyd", "d.test.voyd"]);
    expect(second).toEqual(["b.test.voyd", "e.test.voyd"]);
    expect(third).toEqual(["c.test.voyd"]);
    expect([...first, ...second, ...third].sort()).toEqual(files);
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
