import { describe, expect, test } from "vitest";
import { typeKey } from "../type-key.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";

describe("typeKey", () => {
  test("produces identical fingerprints for recursive map/array unions", () => {
    const recA = createRecursiveUnion();
    const recB = createRecursiveUnion();

    const aliasKeyA = typeKey(recA.alias);
    const aliasKeyB = typeKey(recB.alias);
    expect(aliasKeyA).toBe(aliasKeyB);

    const unionKeyA = typeKey(recA.union);
    const unionKeyB = typeKey(recB.union);
    expect(unionKeyA).toBe(unionKeyB);
  });
});
