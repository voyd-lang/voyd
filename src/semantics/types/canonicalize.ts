import {
  Type,
  UnionType,
  IntersectionType,
  FnType,
  ObjectType,
} from "../../syntax-objects/types.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { resolveTypeExpr } from "../resolution/resolve-type-expr.js";

/**
 * Produce a canonicalized view of a type without mutating the input.
 *
 * Notes:
 * - For alias types, returns the canonicalized target type.
 * - For unions/intersections/functions, returns cloned nodes with rewritten children.
 * - Object and trait types may be shallow-cloned when applied type args are present.
 *
 * This function is intentionally non-mutating. Always use its return value.
 */
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
      if ((c as any).isUnionType?.())
        parts.push(...((c as any).types as Type[]));
      else parts.push(c);
    });
    const unique: Type[] = [];
    const ids = new Set<string>();
    parts.forEach((p) => {
      if (ids.has(p.id)) return;
      ids.add(p.id);
      unique.push(p);
    });
    const clone = (t as UnionType).clone();
    (clone as UnionType).types = unique as any;
    return clone;
  }

  if (t.isIntersectionType?.()) {
    const nom = t.nominalType
      ? (canonicalType(t.nominalType, seen) as Type)
      : undefined;
    const str = t.structuralType
      ? (canonicalType(t.structuralType, seen) as Type)
      : undefined;
    const clone = (t as IntersectionType).clone();
    // Prevent self references
    clone.nominalType = nom === t ? undefined : (nom as ObjectType);
    clone.structuralType = str === t ? undefined : (str as ObjectType);
    if (!clone.nominalType) return clone.structuralType as Type;
    if (!clone.structuralType) return clone.nominalType;
    return clone;
  }

  if (t.isFnType?.()) {
    const src = t as FnType;
    const clone = src.clone();
    // Return type (use returnTypeExpr fallback when needed)
    const ret =
      src.returnType ??
      (src.returnTypeExpr
        ? getExprType(resolveTypeExpr(src.returnTypeExpr))
        : undefined);
    if (ret) clone.returnType = canonicalType(ret, seen);
    // Parameter types (use typeExpr fallback when needed)
    clone.parameters.forEach((p, i) => {
      const sp = src.parameters[i];
      const pt =
        sp?.type ??
        (sp?.typeExpr ? getExprType(resolveTypeExpr(sp.typeExpr)) : undefined);
      if (pt) p.type = canonicalType(pt, seen);
    });
    return clone;
  }

  if (t.isObjectType?.()) {
    if (t.appliedTypeArgs?.length || t.parentObjType) {
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
      copy.binaryenType = undefined;
      copy.setAttribute?.("binaryenType", undefined);
      copy.setAttribute?.("originalType", undefined);
      if (Array.isArray(copy.fields)) {
        copy.fields.forEach((field: any) => {
          if (!field) return;
          field.binaryenGetterType = undefined;
          field.binaryenSetterType = undefined;
        });
      }
      copy.id = t.genericParent ? t.genericParent.id : t.id;
      if (t.parentObjType) {
        copy.parentObjType = canonicalType(t.parentObjType, seen) as ObjectType;
      }
      copy.appliedTypeArgs = t.appliedTypeArgs
        ? t.appliedTypeArgs.map((arg) => canonicalType(arg, seen))
        : undefined;
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
      copy.setAttribute?.("binaryenType", undefined);
      copy.id = t.genericParent ? t.genericParent.id : t.id;
      copy.appliedTypeArgs = t.appliedTypeArgs.map((arg) =>
        canonicalType(arg, seen)
      );
      return copy;
    }
    return t;
  }

  return t;
};

export default canonicalType;
