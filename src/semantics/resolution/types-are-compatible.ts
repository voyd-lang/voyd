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

export const typesAreCompatible = (
  /** A is the argument type, the type of the value being passed as b */
  a?: Type,
  /** B is the parameter type, what a should be equivalent to */
  b?: Type,
  opts: {
    /** Will not check that a is an extension of b if true */
    structuralOnly?: boolean;

    /** Will ancestors, the type must be the same regardless of inheritance  */
    exactNominalMatch?: boolean;
  } = {},
  visited: Set<string> = new Set()
): boolean => {
  if (!a || !b) return false;
  // Note: Do not treat unresolved type aliases as compatible here. Generic
  // matching should occur via specialized inference paths to avoid masking
  // real type errors.
  const key = `${a.id}|${b.id}`;
  if (visited.has(key)) return true;
  visited.add(key);

  if (a.isSelfType() && b.isSelfType()) {
    return true;
  }

  // Attempt to get implementation self parameters to match to their trait method. Don't think its working.
  if (
    (a.isObjectType() && b.isSelfType() && b.parentTrait) ||
    (b.isObjectType() && a.isSelfType() && a.parentTrait)
  ) {
    return true;
  }

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
    if (
      (a.name.value === "void" && b.name.value === "voyd") ||
      (a.name.value === "voyd" && b.name.value === "void")
    ) {
      return true;
    }
    return a.id === b.id;
  }

  if (a.isObjectType() && b.isObjectType()) {
    const structural = opts.structuralOnly || b.isStructural;

    if (structural) {
      return b.fields.every((field) => {
        const match = a.fields.find((f) => f.name === field.name);
        return (
          match && typesAreCompatible(field.type, match.type, opts, visited)
        );
      });
    }

    if (a.genericParent && a.genericParent.id === b.genericParent?.id) {
      return !!a.resolvedTypeArgs?.every((arg, index) =>
        typesAreCompatible(
          getExprType(arg),
          getExprType(b.resolvedTypeArgs?.[index]),
          opts,
          visited
        )
      );
    }

    if (a.idNum === b.idNum) return true;

    if (opts.exactNominalMatch) return a.id === b.id;

    return a.extends(b);
  }

  if (a.isObjectType() && b.isTraitType()) {
    const matchesTrait = a.implementations?.some(
      (impl) => impl.trait?.id === b.id
    );
    if (matchesTrait) return true;
    return a.parentObjType
      ? typesAreCompatible(a.parentObjType, b, opts, visited)
      : false;
  }

  if (a.isTraitType() && b.isObjectType()) {
    const matchesTrait = b.implementations?.some(
      (impl) => impl.trait?.id === a.id
    );
    if (matchesTrait) return true;
    return b.parentObjType
      ? typesAreCompatible(a, b.parentObjType, opts, visited)
      : false;
  }

  if (a.isTraitType() && b.isTraitType()) {
    if (a.genericParent && a.genericParent.id === b.genericParent?.id) {
      return !!a.resolvedTypeArgs?.every((arg, index) =>
        typesAreCompatible(
          getExprType(arg),
          getExprType(b.resolvedTypeArgs?.[index]),
          opts,
          visited
        )
      );
    }
    return a.id === b.id;
  }

  if (a.isUnionType() || b.isUnionType()) {
    if (a.isUnionType() && b.isUnionType()) {
      // Handle recursive union types (same syntax node) quickly
      if (a.syntaxId === b.syntaxId) return true;

      const aTypes = flattenUnion(a);
      const bTypes = flattenUnion(b);
      const bMap = new Map<string, Type>();
      for (const t of bTypes) bMap.set(t.id, t);

      for (const aType of aTypes) {
        if (bMap.has(aType.id)) continue;
        let match = false;
        for (const bType of bTypes) {
          if (typesAreCompatible(aType, bType, opts, visited)) {
            match = true;
            break;
          }
        }
        if (!match) return false;
      }
      return true;
    }

    const [unionType, nonUnionType] = a.isUnionType()
      ? [a as UnionType, b]
      : [b as UnionType, a];

    if (!nonUnionType.isObjectType() && !nonUnionType.isIntersectionType()) {
      return false;
    }

    return unionType.resolvedMemberTypes.some((t) =>
      typesAreCompatible(nonUnionType, t, opts, visited)
    );
  }

  if (a.isObjectType() && b.isIntersectionType()) {
    if (!b.nominalType || !b.structuralType) return false;
    return (
      a.extends(b.nominalType) &&
      typesAreCompatible(a, b.structuralType, opts, visited)
    );
  }

  if (a.isIntersectionType() && b.isIntersectionType()) {
    return (
      typesAreCompatible(a.nominalType, b.nominalType, opts, visited) &&
      typesAreCompatible(a.structuralType, b.structuralType, opts, visited)
    );
  }

  if (a.isFixedArrayType() && b.isFixedArrayType()) {
    return typesAreCompatible(a.elemType, b.elemType, opts, visited);
  }

  if (a.isFnType() && b.isFnType()) {
    if (a.parameters.length !== b.parameters.length) return false;
    return (
      typesAreCompatible(a.returnType, b.returnType, opts, visited) &&
      a.parameters.every((p, i) =>
        typesAreCompatible(p.type, b.parameters[i]?.type, opts, visited)
      )
    );
  }

  return false;
};
