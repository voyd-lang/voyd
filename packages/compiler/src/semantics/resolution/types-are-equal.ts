import { Type, UnionType } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";

const flattenUnion = (type: Type): Type[] => {
  if (!type.isUnionType()) return [type];

  const result: Type[] = [];
  const queue: Type[] = [type];
  const seen = new Set<string>();

  while (queue.length) {
    const current = queue.pop()!;

    if (current.isUnionType()) {
      for (const child of current.resolvedMemberTypes) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          queue.push(child);
        }
      }
      continue;
    }

    result.push(current);
  }

  return result;
};

export const typesAreEqual = (
  a?: Type,
  b?: Type,
  visited: Set<string> = new Set()
): boolean => {
  if (!a || !b) return false;
  const key = `${a.id}|${b.id}`;
  if (visited.has(key)) return true;
  visited.add(key);

  if (a.isSelfType() && b.isSelfType()) return true;

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
    return a.id === b.id;
  }

  if (a.isObj() && b.isObj()) {
    const structural = a.isStructural || b.isStructural;
    if (structural) {
      return (
        a.fields.length === b.fields.length &&
        a.fields.every((field) => {
          const match = b.fields.find((f) => f.name === field.name);
          return match && typesAreEqual(field.type, match.type, visited);
        })
      );
    }
    if (a.genericParent && a.genericParent.id === b.genericParent?.id) {
      return !!a.resolvedTypeArgs?.every((arg, index) =>
        typesAreEqual(
          getExprType(arg),
          getExprType(b.resolvedTypeArgs?.[index]),
          visited
        )
      );
    }
    return a.id === b.id;
  }

  if (a.isTraitType() && b.isTraitType()) {
    if (a.genericParent && a.genericParent.id === b.genericParent?.id) {
      return !!a.resolvedTypeArgs?.every((arg, index) =>
        typesAreEqual(
          getExprType(arg),
          getExprType(b.resolvedTypeArgs?.[index]),
          visited
        )
      );
    }
    return a.id === b.id;
  }

  if (a.isUnionType() && b.isUnionType()) {
    const aTypes = flattenUnion(a as UnionType);
    const bTypes = flattenUnion(b as UnionType);
    if (aTypes.length !== bTypes.length) return false;

    const used: boolean[] = bTypes.map(() => false);
    return aTypes.every((aType) => {
      const idx = bTypes.findIndex(
        (bType, i) => !used[i] && typesAreEqual(aType, bType, visited)
      );
      if (idx === -1) return false;
      used[idx] = true;
      return true;
    });
  }

  if (a.isIntersectionType() && b.isIntersectionType()) {
    return (
      typesAreEqual(a.nominalType, b.nominalType, visited) &&
      typesAreEqual(a.structuralType, b.structuralType, visited)
    );
  }

  if (a.isFixedArrayType() && b.isFixedArrayType()) {
    return typesAreEqual(a.elemType, b.elemType, visited);
  }

  if (a.isFnType() && b.isFnType()) {
    if (a.parameters.length !== b.parameters.length) return false;
    return (
      typesAreEqual(a.returnType, b.returnType, visited) &&
      a.parameters.every((p, i) =>
        typesAreEqual(p.type, b.parameters[i]?.type, visited)
      )
    );
  }

  return false;
};
