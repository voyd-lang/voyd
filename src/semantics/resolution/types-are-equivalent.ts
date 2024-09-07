import { Type } from "../../syntax-objects/index.js";

export const typesAreEquivalent = (
  a?: Type,
  b?: Type,
  ignoreExtension?: boolean // Hacky
): boolean => {
  if (!a || !b) return false;

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
    return a.id === b.id;
  }

  if (a.isObjectType() && b.isObjectType()) {
    return (
      (ignoreExtension || a.extends(b)) &&
      b.fields.every((field) => {
        const match = a.fields.find((f) => f.name === field.name);
        return match && typesAreEquivalent(field.type, match.type);
      })
    );
  }

  if (a.isDSArrayType() && b.isDSArrayType()) {
    return typesAreEquivalent(a.elemType, b.elemType);
  }

  return false;
};
