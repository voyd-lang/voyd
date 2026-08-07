import { describe, expect, it } from "vitest";
import { balanceWeightedFiles, parseShard } from "./compiler-test-shards.mjs";

describe("compiler CI test sharding", () => {
  it("assigns every discovered file exactly once", () => {
    const files = ["heavy.test.ts", "medium.test.ts", "new.test.ts"];
    const shards = balanceWeightedFiles({
      files,
      shardCount: 2,
      weights: {
        "heavy.test.ts": 300,
        "medium.test.ts": 200,
      },
      fallbackWeight: 100,
    });

    expect(
      shards.flatMap(({ files: shardFiles }) => shardFiles).sort(),
    ).toEqual(files);
    expect(shards.map(({ weightMs }) => weightMs)).toEqual([300, 300]);
  });

  it("validates one-based shard coordinates", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    expect(() => parseShard("0/2")).toThrow(/between one/);
    expect(() => parseShard("3/2")).toThrow(/between one/);
    expect(() => parseShard("two")).toThrow(/format/);
  });
});
