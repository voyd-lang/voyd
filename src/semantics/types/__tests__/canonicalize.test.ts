import { describe, expect, test } from "vitest";
import { ObjectType, TypeAlias, i32 } from "../../../syntax-objects/types.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { canonicalType } from "../canonicalize.js";

describe("canonicalType", () => {
  test("resolves applied args on object types", () => {
    const obj = new ObjectType({ name: "Box", value: [], typeParameters: [Identifier.from("T")] });
    const alias = new TypeAlias({ name: Identifier.from("Alias"), typeExpr: Identifier.from("i32") });
    alias.type = i32;
    const inst = obj.clone();
    inst.genericParent = obj;
    inst.appliedTypeArgs = [alias];

    const canon = canonicalType(inst) as ObjectType;
    expect(canon.appliedTypeArgs?.[0]).toBe(i32);
    expect(() => canon.clone()).not.toThrow();
  });

  test("resolves applied args on trait types", () => {
    const trait = new TraitType({ name: Identifier.from("Iter"), methods: [], typeParameters: [Identifier.from("T")] });
    const alias = new TypeAlias({ name: Identifier.from("Alias"), typeExpr: Identifier.from("i32") });
    alias.type = i32;
    const inst = trait.clone();
    inst.genericParent = trait;
    inst.appliedTypeArgs = [alias];

    const canon = canonicalType(inst) as TraitType;
    expect(canon.appliedTypeArgs?.[0]).toBe(i32);
    expect(() => canon.clone()).not.toThrow();
    expect(canon.id).toBe(trait.id);
  });
});
