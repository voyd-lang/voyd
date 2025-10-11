import { describe, expect, test } from "vitest";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Fn } from "../../../syntax-objects/fn.js";
import { Block } from "../../../syntax-objects/block.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { UnionType, ObjectType } from "../../../syntax-objects/types.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { typeKey } from "../type-key.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";

const createFnWithReturn = (name: string, returnType: any): Fn => {
  const fn = new Fn({
    name: Identifier.from(name),
    parameters: [],
    body: new Block({ body: [] }),
  });
  fn.returnType = returnType;
  return fn;
};

const findNominal = (union: UnionType, target: string): ObjectType | undefined =>
  union.types.find(
    (t) =>
      t.isObjectType?.() &&
      (t.name.is(target) || t.genericParent?.name.is(target))
  ) as ObjectType | undefined;

describe("canonicalizeResolvedTypes", () => {
  test("dedupes recursive unions by structural fingerprint", () => {
    const recA = createRecursiveUnion();
    const recB = createRecursiveUnion();
    const fnA = createFnWithReturn("fnA", recA.alias);
    const fnB = createFnWithReturn("fnB", recB.alias);

    const module = new VoydModule({
      name: Identifier.from("Test"),
      value: [recA.alias, recB.alias, fnA, fnB],
    });

    canonicalizeResolvedTypes(module);

    const retA = fnA.returnType as UnionType;
    const retB = fnB.returnType as UnionType;

    expect(retA.isUnionType?.()).toBe(true);
    expect(retB.isUnionType?.()).toBe(true);
    expect(typeKey(retA)).toBe(typeKey(retB));
    expect(retA).toBe(retB);
    expect(recA.alias.type).toBe(retA);
    expect(recB.alias.type).toBe(retA);

    const mapType = findNominal(retA, "Map");
    const arrayType = findNominal(retA, "Array");
    expect(mapType).toBeDefined();
    expect(arrayType).toBeDefined();
    expect(mapType?.appliedTypeArgs?.[0]).toBe(retA);
    expect(arrayType?.appliedTypeArgs?.[0]).toBe(retA);
  });

  test("is idempotent across repeated runs", () => {
    const rec = createRecursiveUnion();
    const fn = createFnWithReturn("fnIdem", rec.alias);
    const module = new VoydModule({
      name: Identifier.from("Test2"),
      value: [rec.alias, fn],
    });

    canonicalizeResolvedTypes(module);
    const first = fn.returnType;
    canonicalizeResolvedTypes(module);
    expect(fn.returnType).toBe(first);
  });
});
