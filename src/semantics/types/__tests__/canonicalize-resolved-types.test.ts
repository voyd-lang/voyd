import { describe, expect, test } from "vitest";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Fn } from "../../../syntax-objects/fn.js";
import { Block } from "../../../syntax-objects/block.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { UnionType, ObjectType } from "../../../syntax-objects/types.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";
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

  test("dedupes unions imported across sibling modules", () => {
    const recA = createRecursiveUnion();
    const recB = createRecursiveUnion();

    const modA = new VoydModule({
      name: Identifier.from("Module"),
      value: [recA.alias, createFnWithReturn("fromA", recA.alias)],
    });

    const modB = new VoydModule({
      name: Identifier.from("Module"),
      value: [recB.alias, createFnWithReturn("fromB", recB.alias)],
    });

    const root = new VoydModule({
      name: Identifier.from("Root"),
      value: [modA, modB],
    });

    expect(typeKey(recA.union)).toBe(typeKey(recB.union));

    canonicalizeResolvedTypes(root);

    const fnA = modA.value[1] as Fn;
    const fnB = modB.value[1] as Fn;
    const retA = fnA.returnType as UnionType;
    const retB = fnB.returnType as UnionType;

    expect(retA).toBe(retB);
    expect(recA.alias.type).toBe(retA);
    expect(recB.alias.type).toBe(retA);
  });

  test("dedupes trait and object instantiations with alias type arguments", () => {
    const rec = createRecursiveUnion();
    const aliasFn = createFnWithReturn("aliasFn", rec.alias);

    const boxBase = new ObjectType({
      name: Identifier.from("Box"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });

    const traitBase = new TraitType({
      name: Identifier.from("Iterable"),
      methods: [],
      typeParameters: [Identifier.from("T")],
    });

    const resolvedBoxA = boxBase.clone();
    resolvedBoxA.typeParameters = undefined;
    resolvedBoxA.genericParent = boxBase;
    resolvedBoxA.appliedTypeArgs = [rec.alias];
    resolvedBoxA.typesResolved = true;
    resolvedBoxA.binaryenType = 123;

    const resolvedBoxB = boxBase.clone();
    resolvedBoxB.typeParameters = undefined;
    resolvedBoxB.genericParent = boxBase;
    resolvedBoxB.appliedTypeArgs = [rec.alias];
    resolvedBoxB.typesResolved = true;
    resolvedBoxB.binaryenType = 123;

    const resolvedTraitA = traitBase.clone();
    resolvedTraitA.typeParameters = undefined;
    resolvedTraitA.genericParent = traitBase;
    resolvedTraitA.appliedTypeArgs = [rec.alias];
    resolvedTraitA.typesResolved = true;

    const resolvedTraitB = traitBase.clone();
    resolvedTraitB.typeParameters = undefined;
    resolvedTraitB.genericParent = traitBase;
    resolvedTraitB.appliedTypeArgs = [rec.alias];
    resolvedTraitB.typesResolved = true;

    const fnBoxA = createFnWithReturn("boxA", resolvedBoxA);
    const fnBoxB = createFnWithReturn("boxB", resolvedBoxB);
    const fnTraitA = createFnWithReturn("traitA", resolvedTraitA);
    const fnTraitB = createFnWithReturn("traitB", resolvedTraitB);

    const module = new VoydModule({
      name: Identifier.from("Generics"),
      value: [rec.alias, aliasFn, fnBoxA, fnBoxB, fnTraitA, fnTraitB],
    });

    canonicalizeResolvedTypes(module);

    const canonicalUnion = aliasFn.returnType as UnionType;
    const canonicalBox = fnBoxA.returnType as ObjectType;
    const canonicalBoxDup = fnBoxB.returnType as ObjectType;
    expect(canonicalBox).toBe(canonicalBoxDup);
    expect(canonicalBox.genericParent).toBe(boxBase);
    expect(canonicalBox.appliedTypeArgs?.[0]).toBe(canonicalUnion);
    expect(canonicalBox.typesResolved).toBe(true);
    expect(canonicalBox.binaryenType).toBe(123);

    const canonicalTrait = fnTraitA.returnType as TraitType;
    const canonicalTraitDup = fnTraitB.returnType as TraitType;
    expect(canonicalTrait).toBe(canonicalTraitDup);
    expect(canonicalTrait.genericParent).toBe(traitBase);
    expect(canonicalTrait.appliedTypeArgs?.[0]).toBe(canonicalUnion);
    expect(canonicalTrait.typesResolved).toBe(true);
  });

  test("retains resolved metadata when deduping recursive map instances", () => {
    const rec = createRecursiveUnion();
    const baseMap = rec.mapInstance.genericParent!;

    rec.mapInstance.typeParameters = undefined;
    rec.mapInstance.typesResolved = true;
    rec.mapInstance.binaryenType = 64;

    const duplicateMap = baseMap.clone();
    duplicateMap.typeParameters = undefined;
    duplicateMap.genericParent = baseMap;
    duplicateMap.appliedTypeArgs = [rec.alias];
    duplicateMap.typesResolved = true;
    duplicateMap.binaryenType = 64;

    rec.union.types.push(duplicateMap);

    expect(typeKey(rec.mapInstance)).toBe(typeKey(duplicateMap));

    const fn = createFnWithReturn("useRec", rec.alias);
    const module = new VoydModule({
      name: Identifier.from("Regression"),
      value: [rec.alias, fn],
    });

    const table = new CanonicalTypeTable();
    canonicalizeResolvedTypes(module, { table });
    const events = table.getDedupeEvents();
    const union = fn.returnType as UnionType;
    const maps = union.types.filter(
      (child) =>
        child.isObjectType?.() &&
        ((child as ObjectType).name.is("Map") ||
          (child as ObjectType).genericParent?.name.is("Map"))
    );

    expect(maps).toHaveLength(1);
    const map = maps[0] as ObjectType;
    expect(map.typesResolved).toBe(true);
    expect(map.binaryenType).toBe(64);
    expect(map.appliedTypeArgs?.[0]).toBe(union);

    expect(
      events.some(
        (event) =>
          event.canonical.isObjectType?.() &&
          (event.canonical as ObjectType).genericParent?.name.is("Map")
      )
    ).toBe(true);
  });
});
