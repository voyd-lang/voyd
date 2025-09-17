import { describe, expect, test } from "vitest";

import { canonicalizeResolvedTypes } from "../canonicalize-types.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Variable } from "../../../syntax-objects/variable.js";
import { Identifier } from "../../../syntax-objects/identifier.js";
import { nop } from "../../../syntax-objects/lib/helpers.js";
import { Implementation } from "../../../syntax-objects/implementation.js";
import {
  ObjectType,
  TypeAlias,
  UnionType,
  i32,
  voydBaseObject,
} from "../../../syntax-objects/types.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";

const buildModuleWithDuplicateGenerics = () => {
  const base = new ObjectType({
    name: Identifier.from("Box"),
    value: [],
    parentObj: voydBaseObject,
  });
  base.parentObjType = voydBaseObject;
  base.typesResolved = true;

  const makeInstance = () => {
    const alias = new TypeAlias({
      name: Identifier.from("T"),
      typeExpr: Identifier.from("i32"),
    });
    alias.type = i32;
    const instance = base.clone();
    instance.genericParent = base;
    instance.parentObjType = voydBaseObject;
    instance.appliedTypeArgs = [alias];
    instance.typesResolved = true;
    return instance;
  };

  const instA = makeInstance();
  const instB = makeInstance();

  const unionA = new UnionType({
    name: Identifier.from("UnionA"),
    childTypeExprs: [],
  });
  unionA.types = [instA];

  const unionB = new UnionType({
    name: Identifier.from("UnionB"),
    childTypeExprs: [],
  });
  unionB.types = [instB];

  const varA = new Variable({
    name: Identifier.from("a"),
    isMutable: false,
    initializer: nop(),
    type: unionA,
  });
  varA.inferredType = unionA;

  const varB = new Variable({
    name: Identifier.from("b"),
    isMutable: false,
    initializer: nop(),
    type: unionB,
  });
  varB.inferredType = unionB;

  const module = new VoydModule({
    name: Identifier.from("test"),
    value: [varA, varB],
  });

  return { module, base };
};

const buildModuleWithResolutionMetadata = () => {
  const base = new ObjectType({
    name: Identifier.from("Node"),
    value: [],
    parentObj: voydBaseObject,
  });
  base.parentObjType = voydBaseObject;

  const unresolved = base.clone();
  unresolved.genericParent = base;
  unresolved.parentObjType = voydBaseObject;
  unresolved.typesResolved = false;

  const resolved = base.clone();
  resolved.genericParent = base;
  resolved.parentObjType = voydBaseObject;
  resolved.typesResolved = true;

  const unionA = new UnionType({
    name: Identifier.from("UnionA"),
    childTypeExprs: [],
  });
  unionA.types = [unresolved];

  const unionB = new UnionType({
    name: Identifier.from("UnionB"),
    childTypeExprs: [],
  });
  unionB.types = [resolved];

  const varA = new Variable({
    name: Identifier.from("a"),
    isMutable: false,
    initializer: nop(),
    type: unionA,
  });
  varA.inferredType = unionA;

  const varB = new Variable({
    name: Identifier.from("b"),
    isMutable: false,
    initializer: nop(),
    type: unionB,
  });
  varB.inferredType = unionB;

  const module = new VoydModule({
    name: Identifier.from("test"),
    value: [varA, varB],
  });

  return module;
};

const buildModuleWithDuplicateUnionMembers = () => {
  const base = new ObjectType({
    name: Identifier.from("Payload"),
    value: [],
    parentObj: voydBaseObject,
  });
  base.parentObjType = voydBaseObject;
  base.typesResolved = true;

  const makeInstance = () => {
    const alias = new TypeAlias({
      name: Identifier.from("T"),
      typeExpr: Identifier.from("i32"),
    });
    alias.type = i32;
    const instance = base.clone();
    instance.genericParent = base;
    instance.parentObjType = voydBaseObject;
    instance.appliedTypeArgs = [alias];
    instance.typesResolved = true;
    return instance;
  };

  const instA = makeInstance();
  const instB = makeInstance();

  const union = new UnionType({
    name: Identifier.from("Union"),
    childTypeExprs: [],
  });
  union.types = [instA, instB];

  const variable = new Variable({
    name: Identifier.from("payload"),
    isMutable: false,
    initializer: nop(),
    type: union,
  });
  variable.inferredType = union;

  return new VoydModule({
    name: Identifier.from("test"),
    value: [variable],
  });
};

const buildModuleWithDuplicateTraits = () => {
  const typeParam = Identifier.from("T");
  const base = new TraitType({
    name: Identifier.from("Iterable"),
    methods: [],
    typeParameters: [typeParam],
    implementations: [],
  });
  base.typesResolved = true;

  const makeInstance = (typesResolved: boolean) => {
    const alias = new TypeAlias({
      name: Identifier.from("T"),
      typeExpr: Identifier.from("i32"),
    });
    alias.type = i32;

    const trait = base.clone();
    trait.genericParent = base;
    trait.appliedTypeArgs = [alias];
    trait.typesResolved = typesResolved;

    const impl = new Implementation({
      parent: trait,
      typeParams: [],
      targetTypeExpr: Identifier.from("IterableTarget"),
      body: nop(),
      traitExpr: Identifier.from("Iterable"),
    });
    impl.trait = trait;
    impl.typesResolved = typesResolved;
    trait.implementations = [impl];
    if (typesResolved) {
      trait.genericInstances = [trait];
    }

    return { trait, impl };
  };

  const { trait: incompleteTrait, impl: firstImpl } = makeInstance(false);
  const { trait: resolvedTrait, impl: secondImpl } = makeInstance(true);

  const varA = new Variable({
    name: Identifier.from("a"),
    isMutable: false,
    initializer: nop(),
    type: incompleteTrait,
  });
  varA.inferredType = incompleteTrait;

  const varB = new Variable({
    name: Identifier.from("b"),
    isMutable: false,
    initializer: nop(),
    type: resolvedTrait,
  });
  varB.inferredType = resolvedTrait;

  const module = new VoydModule({
    name: Identifier.from("trait-test"),
    value: [varA, varB],
  });

  return { module, firstImpl, secondImpl };
};

describe("canonicalizeResolvedTypes", () => {
  test("deduplicates identical generic instances", () => {
    const { module, base } = buildModuleWithDuplicateGenerics();
    canonicalizeResolvedTypes(module);

    const vars = module.value as Variable[];
    expect(vars[0]?.type).toBe(vars[1]?.type);

    const union = vars[0]?.type as UnionType;
    expect(union.types.length).toBe(1);
    const obj = union.types[0] as ObjectType;
    expect(obj.genericParent).toBe(base);
    expect(obj.appliedTypeArgs?.[0]?.isTypeAlias()).toBe(true);
    const alias = obj.appliedTypeArgs?.[0] as TypeAlias;
    expect(alias.type).toBe(i32);
  });

  test("is idempotent", () => {
    const { module } = buildModuleWithDuplicateGenerics();
    canonicalizeResolvedTypes(module);
    const firstType = (module.value[0] as Variable).type;
    canonicalizeResolvedTypes(module);
    const vars = module.value as Variable[];
    expect(vars[0]?.type).toBe(firstType);
    expect(vars[1]?.type).toBe(firstType);
  });

  test("merges resolution metadata when later instances are more complete", () => {
    const module = buildModuleWithResolutionMetadata();
    canonicalizeResolvedTypes(module);

    const vars = module.value as Variable[];
    expect(vars[0]?.type).toBe(vars[1]?.type);

    const union = vars[0]?.type as UnionType;
    expect(union.types.length).toBe(1);
    const obj = union.types[0] as ObjectType;
    expect(obj.typesResolved).toBe(true);
  });

  test("collapses duplicate union members", () => {
    const module = buildModuleWithDuplicateUnionMembers();
    canonicalizeResolvedTypes(module);

    const variable = module.value[0] as Variable;
    const union = variable.type as UnionType;
    expect(union.types.length).toBe(1);
  });

  test("deduplicates trait instances and preserves metadata", () => {
    const { module, firstImpl, secondImpl } = buildModuleWithDuplicateTraits();
    canonicalizeResolvedTypes(module);

    const vars = module.value as Variable[];
    expect(vars[0]?.type).toBe(vars[1]?.type);

    const trait = vars[0]?.type as TraitType;
    expect(trait.typesResolved).toBe(true);
    expect(trait.genericInstances?.length).toBeGreaterThan(0);
    expect(trait.implementations).toHaveLength(2);
    expect(trait.implementations).toEqual(
      expect.arrayContaining([firstImpl, secondImpl])
    );
  });
});

