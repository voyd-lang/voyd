import { Expr } from "../../syntax-objects/expr.js";
import { Identifier, List } from "../../syntax-objects/index.js";
import {
  FixedArrayType,
  IntersectionType,
  ObjectField,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";

/**
 * Produce a compact, canonical type expression from a resolved Type.
 * - Never embeds value-level AST (initializers, calls used for values, etc.).
 * - Prefers identifiers for aliases and nominal types where possible.
 * - Uses shallow structural shapes for structural types (tuples/objects).
 */
export const canonicalTypeExprFromType = (t?: Type): Expr | undefined => {
  if (!t) return undefined;

  // Primitive, Fn, Self etc. can be used directly as type exprs
  if (t.isPrimitiveType() || t.isFnType() || t.isSelfType() || t.isTrait()) {
    return t;
  }

  // Prefer identifier for type aliases to avoid carrying their inner expr trees
  if (t.isTypeAlias()) {
    // Preserve alias identity to keep generic/union resolution stable
    return t.clone();
  }

  // Structural object types → shallow structural form with canonical children
  if (t.isObjectType()) {
    if (t.isStructural) {
      return new ObjectType({
        name: Identifier.from(t.name.value),
        value: t.fields.map((f): ObjectField => ({
          name: f.name,
          // Prefer the resolved field type; fall back to existing type expr's type
          typeExpr:
            canonicalTypeExprFromType(f.type ?? getExprType(f.typeExpr)) ??
            // In worst case, fall back to the original field typeExpr (should be rare)
            f.typeExpr.clone(),
        })),
        isStructural: true,
      });
    }

    // Nominal object types can be used directly as type exprs
    return t;
  }

  if (t.isFixedArrayType()) {
    const elem = t.elemType ?? getExprType(t.elemTypeExpr);
    return new FixedArrayType({
      name: Identifier.from("FixedArray"),
      elemTypeExpr: (canonicalTypeExprFromType(elem) ?? t.elemTypeExpr.clone()) as Expr,
    });
  }

  if (t.isTupleType()) {
    // Represent tuple as a structural ObjectType with numeric fields, for consistency
    return new ObjectType({
      name: Identifier.from("Tuple"),
      value: t.value.map((child, i) => ({
        name: i.toString(),
        typeExpr: (canonicalTypeExprFromType(child) ?? child) as Expr,
      })),
      isStructural: true,
    });
  }

  if (t.isUnionType()) {
    // Rebuild union with canonical child exprs
    const childExprs = t.types.length
      ? t.types.map((child) => (canonicalTypeExprFromType(child) ?? child) as Expr)
      : t.childTypeExprs.toArray();
    return new UnionType({ name: Identifier.from("Union"), childTypeExprs: childExprs });
  }

  if (t.isIntersectionType()) {
    const left = t.nominalType ?? getExprType(t.nominalTypeExpr.value);
    const right = t.structuralType ?? getExprType(t.structuralTypeExpr.value);
    return new IntersectionType({
      name: Identifier.from("Intersection"),
      nominalObjectExpr: (canonicalTypeExprFromType(left) ?? t.nominalTypeExpr.value.clone()) as Expr,
      structuralObjectExpr: (canonicalTypeExprFromType(right) ?? t.structuralTypeExpr.value.clone()) as Expr,
    });
  }

  // Fallback: use the type itself
  return t;
};
