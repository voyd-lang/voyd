import { describe, expect, test } from "vitest";
import { typeKey } from "../type-key.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { ObjectType, PrimitiveType } from "../../../syntax-objects/types.js";

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

  test("differentiates recursive aliases with distinct ancestry", () => {
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");

    expect(typeKey(recType.alias)).not.toBe(typeKey(msgPack.alias));
    expect(typeKey(recType.union)).not.toBe(typeKey(msgPack.union));
  });

  test("distinguishes generic instances with different nominal parents", () => {
    const base = new ObjectType({
      name: Identifier.from("Container"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });
    const otherBase = new ObjectType({
      name: Identifier.from("OtherContainer"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });

    const instance = base.clone();
    instance.genericParent = base;
    instance.appliedTypeArgs = [PrimitiveType.from("i32")];

    const otherInstance = otherBase.clone();
    otherInstance.genericParent = otherBase;
    otherInstance.appliedTypeArgs = [PrimitiveType.from("i32")];

    expect(typeKey(instance)).not.toBe(typeKey(otherInstance));
  });
});
