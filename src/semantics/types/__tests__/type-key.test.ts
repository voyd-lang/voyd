import { describe, expect, test } from "vitest";
import { typeKey } from "../type-key.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";
import { Identifier } from "../../../syntax-objects/index.js";
import {
  ObjectType,
  PrimitiveType,
  Type,
  UnionType,
} from "../../../syntax-objects/types.js";

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

  test("collapses recursive aliases with distinct ancestry once structures match", () => {
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");

    expect(typeKey(recType.alias)).toBe(typeKey(msgPack.alias));
    expect(typeKey(recType.union)).toBe(typeKey(msgPack.union));
  });

  test("distinguishes recursive aliases when structure diverges", () => {
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");
    msgPack.union.types.push(PrimitiveType.from("bool"));

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

  const createOptionalFactory = () => {
    const someBase = new ObjectType({
      name: Identifier.from("Some"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });
    const noneBase = new ObjectType({
      name: Identifier.from("None"),
      value: [],
    });

    const createSomeInstance = (arg: Type): ObjectType => {
      const some = someBase.clone();
      some.genericParent = someBase;
      some.typeParameters = undefined;
      some.appliedTypeArgs = [arg];
      return some;
    };

    const createOptionalUnion = (arg: Type): UnionType => {
      const union = new UnionType({
        name: Identifier.from("Optional"),
        childTypeExprs: [],
      });
      union.types = [createSomeInstance(arg), noneBase];
      return union;
    };

    return { createSomeInstance, createOptionalUnion };
  };

  test("normalizes Some<T> fingerprints once element aliases canonicalize", () => {
    const { createSomeInstance } = createOptionalFactory();
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");

    const someFromAlias = createSomeInstance(recType.alias);
    const someFromMsgPack = createSomeInstance(msgPack.alias);

    expect(typeKey(someFromAlias)).toBe(typeKey(someFromMsgPack));
  });

  test("produces identical Optional<T> fingerprints when element unions match", () => {
    const { createOptionalUnion } = createOptionalFactory();
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");

    const optionalFromAlias = createOptionalUnion(recType.alias);
    const optionalFromMsgPack = createOptionalUnion(msgPack.alias);

    expect(typeKey(optionalFromAlias)).toBe(typeKey(optionalFromMsgPack));
  });
});
