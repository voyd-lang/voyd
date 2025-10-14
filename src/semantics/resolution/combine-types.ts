import {
  IntersectionType,
  ObjectType,
  Type,
  UnionType,
} from "../../syntax-objects/types.js";
import { internTypeWithContext } from "../types/type-context.js";
import { typesAreEqual } from "./types-are-equal.js";

export const combineTypes = (types: Type[]): Type | undefined => {
  if (!types.length) return undefined;

  const unique = types.filter(
    (t, i) => !types.slice(0, i).some((u) => typesAreEqual(t, u))
  );
  const firstType = unique[0];
  if (!firstType?.isObjectType()) return internTypeWithContext(firstType);

  let isLocalUnion = false;
  let topType: ObjectType | IntersectionType | UnionType = firstType;
  for (const type of unique.slice(1)) {
    if (isObjectOrIntersection(type) && isObjectOrIntersection(topType)) {
      const union = new UnionType({ name: `CombinedTypeUnion` });
      union.types = [topType, type];
      topType = union;
      isLocalUnion = true;
      continue;
    }

    if (isObjectOrIntersection(type) && topType.isUnionType() && isLocalUnion) {
      topType.types.push(type);
      continue;
    }

    if (type.isUnionType() && isObjectOrIntersection(topType)) {
      const obj = topType;
      topType = type;
      if (isLocalUnion) type.types.push(obj);
      continue;
    }

    if (type.isUnionType() && topType.isUnionType() && isLocalUnion) {
      const union = topType as UnionType;
      for (const child of type.types) {
        if (!union.types.some((t) => typesAreEqual(t, child))) {
          union.types.push(child);
        }
      }
      topType = union;
      continue;
    }

    return undefined;
  }

  return internTypeWithContext(topType);
};

const isObjectOrIntersection = (
  type: Type
): type is ObjectType | IntersectionType => {
  return type.isObjectType() || type.isIntersectionType();
};
