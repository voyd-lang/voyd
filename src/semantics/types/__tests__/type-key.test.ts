import { describe, expect, test } from "vitest";
import {
  ObjectType,
  TypeAlias,
  UnionType,
} from "../../../syntax-objects/types.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { typeKey } from "../type-key.js";

const mapBase = new ObjectType({
  name: Identifier.from("Map"),
  value: [],
  typeParameters: [Identifier.from("T")],
});

const arrayBase = new ObjectType({
  name: Identifier.from("Array"),
  value: [],
  typeParameters: [Identifier.from("T")],
});

const stringType = new ObjectType({
  name: Identifier.from("String"),
  value: [],
});

type RecTypeInstance = {
  alias: TypeAlias;
  union: UnionType;
};

const createRecType = (): RecTypeInstance => {
  const union = new UnionType({
    name: Identifier.from("RecType"),
    childTypeExprs: [],
  });
  const alias = new TypeAlias({
    name: Identifier.from("RecType"),
    typeExpr: Identifier.from("RecType"),
  });

  const mapInstance = mapBase.clone();
  mapInstance.genericParent = mapBase;
  mapInstance.appliedTypeArgs = [alias];

  const arrayInstance = arrayBase.clone();
  arrayInstance.genericParent = arrayBase;
  arrayInstance.appliedTypeArgs = [alias];

  alias.type = union;
  union.types = [mapInstance, arrayInstance, stringType];

  return { alias, union };
};

describe("typeKey", () => {
  test("produces identical fingerprints for recursive map/array unions", () => {
    const recA = createRecType();
    const recB = createRecType();

    const aliasKeyA = typeKey(recA.alias);
    const aliasKeyB = typeKey(recB.alias);
    expect(aliasKeyA).toBe(aliasKeyB);

    const unionKeyA = typeKey(recA.union);
    const unionKeyB = typeKey(recB.union);
    expect(unionKeyA).toBe(unionKeyB);
  });
});
