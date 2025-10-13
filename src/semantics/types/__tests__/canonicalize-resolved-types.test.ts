import { describe, expect, test } from "vitest";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Fn } from "../../../syntax-objects/fn.js";
import { Block } from "../../../syntax-objects/block.js";
import { Identifier } from "../../../syntax-objects/index.js";
import {
  UnionType,
  ObjectType,
  Type,
  TypeAlias,
  FnType,
} from "../../../syntax-objects/types.js";
import { Call } from "../../../syntax-objects/call.js";
import { List } from "../../../syntax-objects/list.js";
import { Implementation } from "../../../syntax-objects/implementation.js";
import { Closure } from "../../../syntax-objects/closure.js";
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

  test("dedupes recursive unions from aliases with different names", () => {
    const recType = createRecursiveUnion("RecType");
    const msgPack = createRecursiveUnion("MsgPack");
    const fnRec = createFnWithReturn("fromRec", recType.alias);
    const fnMsg = createFnWithReturn("fromMsg", msgPack.alias);

    const module = new VoydModule({
      name: Identifier.from("MixedAliases"),
      value: [recType.alias, msgPack.alias, fnRec, fnMsg],
    });

    canonicalizeResolvedTypes(module);

    const retRec = fnRec.returnType as UnionType;
    const retMsg = fnMsg.returnType as UnionType;

    expect(typeKey(recType.alias)).toBe(typeKey(msgPack.alias));
    expect(retRec).toBe(retMsg);
    expect(recType.alias.type).toBe(retRec);
    expect(msgPack.alias.type).toBe(retRec);
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

  test("dedupes optional constructors when element aliases share canonical unions", () => {
    const rec = createRecursiveUnion("RecType");
    const someBase = new ObjectType({
      name: Identifier.from("Some"),
      value: [
        {
          name: "value",
          typeExpr: Identifier.from("T"),
        },
      ],
      typeParameters: [Identifier.from("T")],
    });
    const noneBase = new ObjectType({
      name: Identifier.from("None"),
      value: [],
    });
    noneBase.typesResolved = true;
    noneBase.binaryenType = 54;

    const createSomeInstance = (arg: Type) => {
      const some = someBase.clone();
      some.genericParent = someBase;
      some.typeParameters = undefined;
      some.appliedTypeArgs = [arg];
      some.fields[0].type = arg;
      some.typesResolved = true;
      return some;
    };

    const optionalFromAlias = new UnionType({
      name: Identifier.from("OptionalAlias"),
      childTypeExprs: [],
    });
    const someAlias = createSomeInstance(rec.alias);
    optionalFromAlias.types = [someAlias, noneBase];

    const optionalFromUnion = new UnionType({
      name: Identifier.from("OptionalUnion"),
      childTypeExprs: [],
    });
    const someUnion = createSomeInstance(rec.union);
    optionalFromUnion.types = [someUnion, noneBase];

    someBase.genericInstances = [someAlias, someUnion];

    const fnAlias = createFnWithReturn("fromAlias", optionalFromAlias);
    const fnUnion = createFnWithReturn("fromUnion", optionalFromUnion);

    const module = new VoydModule({
      name: Identifier.from("OptionalModule"),
      value: [rec.alias, fnAlias, fnUnion],
    });

    canonicalizeResolvedTypes(module);

    const aliasReturn = fnAlias.returnType as UnionType;
    const unionReturn = fnUnion.returnType as UnionType;
    expect(aliasReturn).toBe(unionReturn);

    const instances = someBase.genericInstances ?? [];
    expect(instances).toHaveLength(1);
    const canonicalSome = instances[0];
    const appliedArg = canonicalSome.appliedTypeArgs?.[0];
    expect(appliedArg).toBeDefined();
    const canonicalElement = rec.alias.type as UnionType;
    expect(typeKey(appliedArg!)).toBe(typeKey(canonicalElement));
    expect(canonicalSome.fields[0].type).toBeDefined();
    expect(typeKey(canonicalSome.fields[0].type!)).toBe(
      typeKey(canonicalElement)
    );
  });

  test("rewrites optional unions to canonical constructors across containers", () => {
    const rec = createRecursiveUnion("RecType");

    const someBase = new ObjectType({
      name: Identifier.from("Some"),
      value: [
        {
          name: "value",
          typeExpr: Identifier.from("T"),
        },
      ],
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
      some.fields[0].type = arg;
      some.typesResolved = true;
      return some;
    };

    const someFromAlias = createSomeInstance(rec.alias);
    const someFromUnion = createSomeInstance(rec.union);
    someFromAlias.fields[0].binaryenGetterType = 19;
    someFromUnion.fields[0].binaryenSetterType = 27;
    someFromUnion.binaryenType = 88;

    const optionalFromAlias = new UnionType({
      name: Identifier.from("OptionalAlias"),
      childTypeExprs: [],
    });
    optionalFromAlias.types = [someFromAlias, noneBase];

    const optionalAlias = new TypeAlias({
      name: Identifier.from("OptionalAlias"),
      typeExpr: optionalFromAlias,
    });
    optionalAlias.type = optionalFromAlias;
    optionalFromAlias.parent = optionalAlias;

    const optionalFromUnion = new UnionType({
      name: Identifier.from("OptionalUnion"),
      childTypeExprs: [],
    });
    optionalFromUnion.types = [someFromUnion, noneBase];

    someBase.genericInstances = [someFromAlias, someFromUnion];

    const arrayBase = new ObjectType({
      name: Identifier.from("Array"),
      value: [
        {
          name: "items",
          typeExpr: Identifier.from("T"),
        },
      ],
      typeParameters: [Identifier.from("T")],
    });

    const createArrayInstance = (arg: Type): ObjectType => {
      const array = arrayBase.clone();
      array.genericParent = arrayBase;
      array.typeParameters = undefined;
      array.appliedTypeArgs = [arg];
      array.fields[0].type = arg;
      return array;
    };

    const arrayAlias = createArrayInstance(optionalAlias);
    const arrayUnion = createArrayInstance(optionalFromUnion);
    arrayAlias.fields[0].binaryenGetterType = 31;
    arrayUnion.fields[0].binaryenSetterType = 49;
    arrayUnion.binaryenType = 61;
    arrayAlias.typesResolved = true;
    arrayUnion.typesResolved = true;

    const mapBase = new ObjectType({
      name: Identifier.from("Map"),
      value: [
        {
          name: "keys",
          typeExpr: Identifier.from("K"),
        },
        {
          name: "values",
          typeExpr: Identifier.from("V"),
        },
      ],
      typeParameters: [Identifier.from("K"), Identifier.from("V")],
    });

    const createMapInstance = (valueType: Type): ObjectType => {
      const map = mapBase.clone();
      map.genericParent = mapBase;
      map.typeParameters = undefined;
      map.appliedTypeArgs = [rec.union, valueType];
      map.fields[0].type = rec.union;
      map.fields[1].type = valueType;
      return map;
    };

    const mapAlias = createMapInstance(optionalAlias);
    const mapUnion = createMapInstance(optionalFromUnion);
    mapAlias.fields[1].binaryenGetterType = 71;
    mapUnion.fields[1].binaryenSetterType = 83;
    mapUnion.binaryenType = 97;
    mapAlias.typesResolved = true;
    mapUnion.typesResolved = true;

    const fnOptionalAlias = createFnWithReturn("optionalAlias", optionalAlias);
    const fnOptionalUnion = createFnWithReturn("optionalUnion", optionalFromUnion);
    const fnArrayAlias = createFnWithReturn("arrayAlias", arrayAlias);
    const fnArrayUnion = createFnWithReturn("arrayUnion", arrayUnion);
    const fnMapAlias = createFnWithReturn("mapAlias", mapAlias);
    const fnMapUnion = createFnWithReturn("mapUnion", mapUnion);

    const module = new VoydModule({
      name: Identifier.from("OptionalContainers"),
      value: [
        rec.alias,
        fnOptionalAlias,
        fnOptionalUnion,
        fnArrayAlias,
        fnArrayUnion,
        fnMapAlias,
        fnMapUnion,
      ],
    });

    canonicalizeResolvedTypes(module);

    const canonicalOptional = fnOptionalAlias.returnType as UnionType;
    const unionOptional = fnOptionalUnion.returnType as UnionType;
    expect(canonicalOptional).toBe(unionOptional);

    const canonicalSome = canonicalOptional.types.find(
      (type) =>
        type.isObjectType?.() &&
        ((type as ObjectType).name.is("Some") ||
          (type as ObjectType).genericParent?.name.is("Some"))
    ) as ObjectType | undefined;
    expect(canonicalSome).toBeDefined();

    const canonicalNone = canonicalOptional.types.find(
      (type) =>
        type.isObjectType?.() &&
        ((type as ObjectType).name.is("None") ||
          (type as ObjectType).genericParent?.name.is("None"))
    ) as ObjectType | undefined;
    expect(canonicalNone).toBeDefined();
    expect(canonicalNone).toBe(noneBase);

    expect(someBase.genericInstances).toHaveLength(1);
    expect(someBase.genericInstances?.[0]).toBe(canonicalSome);

    const canonicalElement = rec.alias.type as UnionType;
    expect(canonicalSome?.appliedTypeArgs?.[0]).toBe(canonicalElement);
    const valueField = canonicalSome?.fields[0];
    expect(valueField?.type).toBe(canonicalElement);
    expect(valueField?.binaryenGetterType).toBe(19);
    expect(valueField?.binaryenSetterType).toBe(27);
    expect(canonicalSome?.binaryenType).toBe(88);

    const canonicalArray = fnArrayAlias.returnType as ObjectType;
    expect(canonicalArray).toBe(fnArrayUnion.returnType);
    expect(canonicalArray.appliedTypeArgs?.[0]).toBe(canonicalOptional);
    const arrayField = canonicalArray.fields[0];
    expect(arrayField.type).toBe(canonicalOptional);
    expect(arrayField.binaryenGetterType).toBe(31);
    expect(arrayField.binaryenSetterType).toBe(49);
    expect(canonicalArray.binaryenType).toBe(61);

    const canonicalMap = fnMapAlias.returnType as ObjectType;
    expect(canonicalMap).toBe(fnMapUnion.returnType);
    expect(canonicalMap.appliedTypeArgs?.[1]).toBe(canonicalOptional);
    const mapField = canonicalMap.fields[1];
    expect(mapField.type).toBe(canonicalOptional);
    expect(mapField.binaryenGetterType).toBe(71);
    expect(mapField.binaryenSetterType).toBe(83);
    expect(canonicalMap.binaryenType).toBe(97);
  });

  test(
    "canonicalizes fn instances, impl methods, trait tables, and call caches",
    () => {
      const recPrimary = createRecursiveUnion("RecPrimary");
      const recClone = createRecursiveUnion("RecPrimaryClone");

      const fnBase = createFnWithReturn("build", recPrimary.alias);
      const specialized = createFnWithReturn("buildClone", recClone.alias);
      specialized.inferredReturnType = recClone.alias;
      specialized.annotatedReturnType = recClone.alias;
      fnBase.registerGenericInstance(specialized);

      const closure = new Closure({
        body: new Block({ body: [] }),
      });
      closure.returnType = recClone.alias;
      closure.annotatedReturnType = recClone.alias;
      const closureFnType = new FnType({
        name: Identifier.from("closureType"),
        parameters: [],
        returnType: recClone.alias,
      });
      closure.setAttribute("parameterFnType", closureFnType);

      const call = new Call({
        fnName: Identifier.from("Map"),
        args: new List({ value: [closure] }),
        fn: recClone.mapInstance,
        type: recClone.mapInstance,
      });
      call.setAttribute("expectedType", recClone.union);

      fnBase.body = new Block({ body: [closure, call] });

      const traitMethod = createFnWithReturn("iterate", recClone.alias);
      const trait = new TraitType({
        name: Identifier.from("Iterable"),
        methods: [traitMethod],
        typeParameters: [Identifier.from("T")],
      });
      trait.appliedTypeArgs = [recClone.alias];

      const implMethod = createFnWithReturn("iterateImpl", recClone.alias);
      const impl = new Implementation({
        typeParams: [],
        targetTypeExpr: Identifier.from("Target"),
        body: new Block({ body: [] }),
        traitExpr: trait,
      });
      impl.trait = trait;
      impl.targetType = recClone.mapInstance;
      impl.registerMethod(implMethod);

      const module = new VoydModule({
        name: Identifier.from("Coverage"),
        value: [recPrimary.alias, recClone.alias, fnBase, trait, impl],
      });

      canonicalizeResolvedTypes(module);

      const canonicalUnion = fnBase.returnType as UnionType;
      const canonicalMap = findNominal(canonicalUnion, "Map")!;
      const expectedType = call.getAttribute("expectedType") as UnionType;
      const closureAttr = closure.getAttribute("parameterFnType") as FnType;

      expect(specialized.returnType).toBe(canonicalUnion);
      expect(specialized.inferredReturnType).toBe(canonicalUnion);
      expect(specialized.annotatedReturnType).toBe(canonicalUnion);
      expect(closure.returnType).toBe(canonicalUnion);
      expect(closure.annotatedReturnType).toBe(canonicalUnion);
      expect(closureAttr.returnType).toBe(canonicalUnion);
      expect(expectedType).toBe(canonicalUnion);
      expect(call.type).toBe(canonicalMap);
      expect(call.fn).toBe(canonicalMap);
      expect(traitMethod.returnType).toBe(canonicalUnion);
      expect(implMethod.returnType).toBe(canonicalUnion);
      expect(impl.targetType).toBe(canonicalMap);
      expect(trait.appliedTypeArgs?.[0]).toBe(canonicalUnion);
    }
  );
});
