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
      for (const child of current.types) {
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
  let aa = a;
  let bb = b;
  if (aa.hasAttribute("mutable") && !bb.hasAttribute("mutable")) {
    aa = aa.clone();
    aa.setAttribute("mutable", undefined);
  }
  if (!aa.hasAttribute("mutable") && bb.hasAttribute("mutable")) return false;
  const key = `${aa.id}|${bb.id}`;
  if (visited.has(key)) return true;
  visited.add(key);

  if (aa.isSelfType() && bb.isSelfType()) {
    return true;
  }

  // Attempt to get implementation self parameters to match to their trait method. Don't think its working.
  if (
    (aa.isObjectType() && bb.isSelfType() && bb.parentTrait) ||
    (bb.isObjectType() && aa.isSelfType() && aa.parentTrait)
  ) {
    return true;
  }

  if (aa.isPrimitiveType() && bb.isPrimitiveType()) {
    if (
      (aa.name.value === "void" && bb.name.value === "voyd") ||
      (aa.name.value === "voyd" && bb.name.value === "void")
    ) {
      return true;
    }
    return aa.id === bb.id;
  }

  if (aa.isObjectType() && bb.isObjectType()) {
    const structural = opts.structuralOnly || bb.isStructural;

    if (structural) {
      return bb.fields.every((field) => {
        const match = aa.fields.find((f) => f.name === field.name);
        return (
          match && typesAreCompatible(field.type, match.type, opts, visited)
        );
      });
    }

    if (aa.genericParent && aa.genericParent.id === bb.genericParent?.id) {
      return !!aa.appliedTypeArgs?.every((arg, index) =>
        typesAreCompatible(
          getExprType(arg),
          getExprType(bb.appliedTypeArgs?.[index]),
          opts,
          visited
        )
      );
    }

    if (aa.idNum === bb.idNum) return true;

    if (opts.exactNominalMatch) return aa.id === bb.id;

    return aa.extends(bb);
  }

  if (aa.isObjectType() && bb.isTraitType()) {
    const matchesTrait = aa.implementations?.some(
      (impl) => impl.trait?.id === bb.id
    );
    if (matchesTrait) return true;
    return aa.parentObjType
      ? typesAreCompatible(aa.parentObjType, bb, opts, visited)
      : false;
  }

  if (aa.isTraitType() && bb.isObjectType()) {
    const matchesTrait = bb.implementations?.some(
      (impl) => impl.trait?.id === aa.id
    );
    if (matchesTrait) return true;
    return bb.parentObjType
      ? typesAreCompatible(aa, bb.parentObjType, opts, visited)
      : false;
  }

  if (aa.isTraitType() && bb.isTraitType()) {
    if (aa.genericParent && aa.genericParent.id === bb.genericParent?.id) {
      return !!aa.appliedTypeArgs?.every((arg, index) =>
        typesAreCompatible(
          getExprType(arg),
          getExprType(bb.appliedTypeArgs?.[index]),
          opts,
          visited
        )
      );
    }
    return aa.id === bb.id;
  }

  if (aa.isUnionType() || bb.isUnionType()) {
    if (aa.isUnionType() && bb.isUnionType()) {
      // This is for handling recursive union types. It may *not* work for generic type aliases. Hopefully no dragons.
      // We may only want to do this when the union's types have not yet been resolved
      if (a.syntaxId === b.syntaxId) return true;

      const aTypes = flattenUnion(aa);
      const bTypes = flattenUnion(bb);

      let bMap: Map<string, Type>;
      bMap = new Map<string, Type>();
      for (const bType of bTypes) {
        bMap.set(bType.id, bType);
      }

      for (const aType of aTypes) {
        if (!bb.isUnionType() && bMap.has(aType.id)) return true;
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

    const [unionType, nonUnionType] = aa.isUnionType()
      ? [aa as UnionType, bb]
      : [bb as UnionType, aa];

    if (!nonUnionType.isObjectType() && !nonUnionType.isIntersectionType()) {
      return false;
    }

    return unionType.types.some((t) =>
      typesAreCompatible(nonUnionType, t, opts, visited)
    );
  }

  if (aa.isObjectType() && bb.isIntersectionType()) {
    if (!bb.nominalType || !bb.structuralType) return false;
    return (
      aa.extends(bb.nominalType) &&
      typesAreCompatible(aa, bb.structuralType, opts, visited)
    );
  }

  if (aa.isIntersectionType() && bb.isIntersectionType()) {
    return (
      typesAreCompatible(aa.nominalType, bb.nominalType, opts, visited) &&
      typesAreCompatible(aa.structuralType, bb.structuralType, opts, visited)
    );
  }

  if (aa.isFixedArrayType() && bb.isFixedArrayType()) {
    return typesAreCompatible(aa.elemType, bb.elemType, opts, visited);
  }

  if (aa.isFnType() && bb.isFnType()) {
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
