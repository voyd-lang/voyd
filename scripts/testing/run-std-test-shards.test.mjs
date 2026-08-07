import { describe, expect, it } from "vitest";
import { parseShard, partitionsForShard } from "./run-std-test-shards.mjs";

describe("std CI test sharding", () => {
  it("assigns every physical quartile to one logical CI shard", () => {
    const first = partitionsForShard("1/2");
    const second = partitionsForShard("2/2");

    expect(first).toEqual([
      { index: 1, count: 4 },
      { index: 3, count: 4 },
    ]);
    expect(second).toEqual([
      { index: 0, count: 4 },
      { index: 2, count: 4 },
    ]);
    expect([...first, ...second].map(({ index }) => index).sort()).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("retains full local coverage and direct diagnostic shards", () => {
    expect(partitionsForShard(undefined)).toEqual([{ index: 0, count: 1 }]);
    expect(partitionsForShard("3/4")).toEqual([{ index: 2, count: 4 }]);
  });

  it("rejects invalid shard coordinates", () => {
    expect(() => parseShard("0/2")).toThrow(/within/);
    expect(() => parseShard("3/2")).toThrow(/within/);
    expect(() => parseShard("two")).toThrow(/format/);
  });
});
