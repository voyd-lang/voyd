import { Type } from "../../syntax-objects/index.js";

export const typesAreEquivalent = (
  /** A is the argument type, the type of the value being passed as b */
  a?: Type,
  /** B is the parameter type, what a should be equivalent to */
  b?: Type,
  opts: {
    /** Will not check that a is an extension of b if true */
    structuralOnly?: boolean;

    /** Will ancestors, the type must be the same regardless of inheritance  */
    exactNominalMatch?: boolean;
  } = {}
): boolean => {
  if (!a || !b) return false;

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
    return a.id === b.id;
  }

  if (a.isObjectType() && b.isObjectType()) {
    const structural = opts.structuralOnly || b.getAttribute("isStructural");
    if (opts.exactNominalMatch) return a.id === b.id;

    if (structural) {
      return b.fields.every((field) => {
        const match = a.fields.find((f) => f.name === field.name);
        return match && typesAreEquivalent(field.type, match.type);
      });
    }

    return a.extends(b);
  }

  if (a.isObjectType() && b.isUnionType()) {
    return b.types.some((type) => typesAreEquivalent(a, type, opts));
  }

  if (a.isDsArrayType() && b.isDsArrayType()) {
    return typesAreEquivalent(a.elemType, b.elemType);
  }

  return false;
};
