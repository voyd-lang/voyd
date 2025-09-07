import { Type } from "../../syntax-objects/types.js";

export const canonicalType = (t: Type, seen: Set<Type> = new Set()): Type => {
  if (seen.has(t)) return t;
  seen.add(t);
  if (t.isTypeAlias?.()) {
    const target = t.type;
    // Avoid infinite recursion on self-referential aliases
    if (!target || seen.has(target)) return t;
    return canonicalType(target, seen);
  }

  if (t.isUnionType?.()) {
    const parts: Type[] = [];
    t.types.forEach((child) => {
      const c = canonicalType(child, seen) as Type;
      // Skip self references which can appear when an alias resolves to this union
      if (c === t) return;
      if ((c as any).isUnionType?.()) parts.push(...((c as any).types as Type[]));
      else parts.push(c);
    });
    t.types = parts as any;
    return t;
  }

  if (t.isIntersectionType?.()) {
    const nom = t.nominalType
      ? (canonicalType(t.nominalType, seen) as Type)
      : undefined;
    const str = t.structuralType
      ? (canonicalType(t.structuralType, seen) as Type)
      : undefined;
    // Prevent self references
    t.nominalType = nom === t ? undefined : (nom as any);
    t.structuralType = str === t ? undefined : (str as any);
    if (!t.nominalType) return t.structuralType as Type;
    if (!t.structuralType) return t.nominalType;
    return t;
  }

  if (t.isFnType?.()) {
    if (t.returnType) t.returnType = canonicalType(t.returnType, seen);
    t.parameters.forEach((p) => {
      if (p.type) p.type = canonicalType(p.type, seen);
    });
    return t;
  }

  return t;
};

export default canonicalType;
