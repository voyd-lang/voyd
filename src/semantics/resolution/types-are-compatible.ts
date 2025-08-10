import { Type } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";

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
  const key = `${a.id}|${b.id}`;
  if (visited.has(key)) return true;
  visited.add(key);

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
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
      return !!a.appliedTypeArgs?.every((arg, index) =>
        typesAreCompatible(
          getExprType(arg),
          getExprType(b.appliedTypeArgs?.[index]),
          opts,
          visited
        )
      );
    }

    if (opts.exactNominalMatch) return a.id === b.id;

    return a.extends(b);
  }

  if (a.isObjectType() && b.isUnionType()) {
    return b.types.some((type) =>
      typesAreCompatible(a, type, opts, visited)
    );
  }

  if (a.isUnionType() && b.isUnionType()) {
    return a.types.every((aType) =>
      b.types.some((bType) =>
        typesAreCompatible(aType, bType, opts, visited)
      )
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
    if (a.name.value !== b.name.value) return false;
    return (
      typesAreCompatible(a.returnType, b.returnType, opts, visited) &&
      a.parameters.every((p, i) =>
        typesAreCompatible(p.type, b.parameters[i]?.type, opts, visited)
      )
    );
  }

  return false;
};
