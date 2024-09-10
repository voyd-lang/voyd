import { Type } from "../../syntax-objects/index.js";

export const typesAreEquivalent = (
  a?: Type,
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
    if (opts.exactNominalMatch) return a.id === b.id;

    return (
      (opts.structuralOnly || a.extends(b)) &&
      b.fields.every((field) => {
        const match = a.fields.find((f) => f.name === field.name);
        return match && typesAreEquivalent(field.type, match.type);
      })
    );
  }

  if (a.isDsArrayType() && b.isDsArrayType()) {
    return typesAreEquivalent(a.elemType, b.elemType);
  }

  return false;
};
