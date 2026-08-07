import { describe, expect, it } from "vitest";
import {
  executionBatches,
  groupsForShard,
  parseShard,
} from "./run-sdk-test-shards.mjs";

describe("SDK CI test sharding", () => {
  it("assigns every test group to one logical CI shard", () => {
    const first = groupsForShard("1/2");
    const second = groupsForShard("2/2");

    expect(first).toEqual(["base"]);
    expect(second).toEqual(["external-a", "external-b"]);
    expect([...first, ...second].sort()).toEqual([
      "base",
      "external-a",
      "external-b",
    ]);
  });

  it("runs all SDK groups in two concurrent batches only by default locally", () => {
    expect(groupsForShard(undefined)).toEqual([
      "base",
      "external-a",
      "external-b",
    ]);
    expect(executionBatches({ shardValue: undefined, isCi: false })).toEqual([
      ["base"],
      ["external-a", "external-b"],
    ]);
    expect(executionBatches({ shardValue: undefined, isCi: true })).toEqual([
      ["base", "external-a", "external-b"],
    ]);
  });

  it("keeps explicit CI shards sequential", () => {
    expect(executionBatches({ shardValue: "1/2", isCi: false })).toEqual([
      ["base"],
    ]);
    expect(executionBatches({ shardValue: "2/2", isCi: false })).toEqual([
      ["external-a", "external-b"],
    ]);
  });

  it("rejects unsupported and invalid shard coordinates", () => {
    expect(() => groupsForShard("1/3")).toThrow(/one or two/);
    expect(() => parseShard("0/2")).toThrow(/within/);
    expect(() => parseShard("3/2")).toThrow(/within/);
    expect(() => parseShard("two")).toThrow(/format/);
  });
});
