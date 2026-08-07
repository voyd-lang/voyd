import { describe, expect, it } from "vitest";
import { groupsForShard, parseShard } from "./run-sdk-test-shards.mjs";

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

  it("retains all SDK groups in the default local suite", () => {
    expect(groupsForShard(undefined)).toEqual([
      "base",
      "external-a",
      "external-b",
    ]);
  });

  it("rejects unsupported and invalid shard coordinates", () => {
    expect(() => groupsForShard("1/3")).toThrow(/one or two/);
    expect(() => parseShard("0/2")).toThrow(/within/);
    expect(() => parseShard("3/2")).toThrow(/within/);
    expect(() => parseShard("two")).toThrow(/format/);
  });
});
