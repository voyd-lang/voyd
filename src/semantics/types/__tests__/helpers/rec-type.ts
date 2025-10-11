import { Identifier } from "../../../../syntax-objects/index.js";
import {
  ObjectType,
  TypeAlias,
  UnionType,
} from "../../../../syntax-objects/types.js";

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

const stringObject = new ObjectType({
  name: Identifier.from("String"),
  value: [],
});

export type RecursiveUnion = {
  alias: TypeAlias;
  union: UnionType;
  mapInstance: ObjectType;
  arrayInstance: ObjectType;
};

export const createRecursiveUnion = (
  name = "RecType"
): RecursiveUnion => {
  const union = new UnionType({
    name: Identifier.from(name),
    childTypeExprs: [],
  });

  const alias = new TypeAlias({
    name: Identifier.from(name),
    typeExpr: union,
  });

  const mapInstance = mapBase.clone();
  mapInstance.genericParent = mapBase;
  mapInstance.appliedTypeArgs = [alias];

  const arrayInstance = arrayBase.clone();
  arrayInstance.genericParent = arrayBase;
  arrayInstance.appliedTypeArgs = [alias];

  alias.type = union;
  union.types = [mapInstance, arrayInstance, stringObject];

  return {
    alias,
    union,
    mapInstance,
    arrayInstance,
  };
};
