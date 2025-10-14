import {
  IntersectionType,
  ObjectType,
  Type,
  UnionType,
} from "../../syntax-objects/types.js";
import { typesAreEqual } from "./types-are-equal.js";
import { registerTypeInstance } from "../../syntax-objects/type-context.js";

/**
 * Combines types into their least common denominator.
 * If all types are the same, it returns that type.
 * If all types are different (but still object types), it returns a UnionType.
 * If types are mixed and not all object types, it returns undefined.
 */
export const combineTypes = (types: Type[]): Type | undefined => {
  const unique = types.filter(
    (t, i) => !types.slice(0, i).some((u) => typesAreEqual(t, u))
  );
  const firstType = unique[0];
  if (!unique.length || !firstType?.isObjectType()) return firstType;

  let isLocalUnion = false;
  let topType: ObjectType | IntersectionType | UnionType = firstType;
  for (const type of unique.slice(1)) {
    if (isObjectOrIntersection(type) && isObjectOrIntersection(topType)) {
      const union = new UnionType({ name: `CombinedTypeUnion` });
      union.types = [topType, type];
      topType = registerTypeInstance(union);
      isLocalUnion = true;
      continue;
    }

    if (isObjectOrIntersection(type) && topType.isUnionType() && isLocalUnion) {
      topType.types.push(type);
      continue;
    }

    // TODO: Fix (V-129)
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

  return topType;
};

const isObjectOrIntersection = (
  type: Type
): type is ObjectType | IntersectionType => {
  return type.isObjectType() || type.isIntersectionType();
};
