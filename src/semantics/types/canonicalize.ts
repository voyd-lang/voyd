import { Type } from "../../syntax-objects/types.js";

const cache = new WeakMap<Type, Type>();

/**
 * Return a canonicalized version of a type without mutating the input.
 *
 * Each call produces a clone of any composite type it rewrites while caching
 * results so repeated canonicalizations of the same input return the same
 * instance.
 */
export const canonicalType = (t: Type, seen: Set<Type> = new Set()): Type => {
  const cached = cache.get(t);
  if (cached) return cached;
  if (seen.has(t)) return t;
  seen.add(t);
  if (t.isTypeAlias?.()) {
    const target = t.type;
    // Avoid infinite recursion on self-referential aliases
    if (!target || seen.has(target)) return t;
    const canon = canonicalType(target, seen);
    cache.set(t, canon);
    return canon;
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
    const unique: Type[] = [];
    const ids = new Set<string>();
    parts.forEach((p) => {
      if (ids.has(p.id)) return;
      ids.add(p.id);
      unique.push(p);
    });
    const copy = t.clone();
    copy.types = unique as any;
    cache.set(t, copy);
    return copy;
  }

  if (t.isIntersectionType?.()) {
    const nom = t.nominalType
      ? (canonicalType(t.nominalType, seen) as Type)
      : undefined;
    const str = t.structuralType
      ? (canonicalType(t.structuralType, seen) as Type)
      : undefined;
    const copy = t.clone();
    // Prevent self references
    copy.nominalType = nom === t ? undefined : (nom as any);
    copy.structuralType = str === t ? undefined : (str as any);
    cache.set(t, copy);
    if (!copy.nominalType) return copy.structuralType as Type;
    if (!copy.structuralType) return copy.nominalType;
    return copy;
  }

  if (t.isFnType?.()) {
    const copy = t.clone();
    copy.parameters.forEach((p, i) => {
      p.type = t.parameters[i]?.type;
      p.originalType = t.parameters[i]?.originalType;
    });
    if (copy.returnType) copy.returnType = canonicalType(copy.returnType, seen);
    copy.parameters.forEach((p) => {
      if (p.type) p.type = canonicalType(p.type, seen);
    });
    cache.set(t, copy);
    return copy;
  }

  if (t.isObjectType?.()) {
    if (t.appliedTypeArgs?.length) {
      const copy = new (t.constructor as any)({
        name: t.name,
        value: [],
        parentObjExpr: t.parentObjExpr,
        parentObj: t.parentObjType,
        typeParameters: t.typeParameters,
        implementations: t.implementations,
        isStructural: t.isStructural,
      });
      Object.assign(copy, t);
      copy.id = `${t.id}#canon`;
      copy.appliedTypeArgs = t.appliedTypeArgs.map((arg) =>
        canonicalType(arg, seen)
      );
      cache.set(t, copy);
      return copy;
      }
      return t;
    }

  if (t.isTraitType?.()) {
    if (t.appliedTypeArgs?.length) {
      const copy = new (t.constructor as any)({
        name: t.name,
        methods: [],
        typeParameters: t.typeParameters,
        implementations: t.implementations,
        lexicon: t.lexicon,
      });
      Object.assign(copy, t);
      copy.appliedTypeArgs = t.appliedTypeArgs.map((arg) =>
        canonicalType(arg, seen)
      );
      cache.set(t, copy);
      return copy;
    }
    return t;
  }

  cache.set(t, t);
  return t;
};

export default canonicalType;
