import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { nop } from "../../syntax-objects/index.js";
import { List } from "../../syntax-objects/list.js";
import { Type, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export type TypeArgInferencePair = {
  typeExpr: Expr;
  argExpr: Expr;
};

/**
 * Recursively walks the type expression and corresponding argument expression
 * to find the sub-expression of the argument that maps to the given type
 * parameter identifier. Traverses calls (generics), tuples and object field
 * types.
 */
const findMatchingExpr = (
  typeExpr: Expr,
  argExpr: Expr,
  tp: Identifier
): Expr | undefined => {
  // Direct identifier match
  if (typeExpr.isIdentifier() && typeExpr.is(tp)) return argExpr;

  // Generic calls such as Array<T>
  if (typeExpr.isCall()) {
    const typeArgs = typeExpr.typeArgs?.toArray();
    if (typeArgs?.length) {
      let argTypeArgs: Expr[] | undefined;

      if (argExpr.isCall() && argExpr.typeArgs?.length) {
        argTypeArgs = argExpr.typeArgs.toArray();
      } else {
        const argType = getExprType(argExpr);
        if (argType?.isObjectType() && argType.appliedTypeArgs) {
          argTypeArgs = argType.appliedTypeArgs;
        } else if (argType?.isFixedArrayType()) {
          // FixedArray<T>
          argTypeArgs = [argType.elemTypeExpr];
        } else if (argType && (argType as any).appliedTypeArgs) {
          // TraitType and other generics
          argTypeArgs = (argType as any).appliedTypeArgs as Expr[];
        }
      }

      if (argTypeArgs) {
        for (let i = 0; i < typeArgs.length && i < argTypeArgs.length; i++) {
          const match = findMatchingExpr(typeArgs[i], argTypeArgs[i], tp);
          if (match) return match;
        }
      }
    }
  }

  // Tuple types represented as (a, b, ...)
  if (typeExpr.isList() && typeExpr.calls("tuple")) {
    const typeElems = typeExpr.toArray().slice(1);
    let argElems: Expr[] | undefined;

    if (argExpr.isList() && argExpr.calls("tuple")) {
      argElems = argExpr.toArray().slice(1);
    } else {
      const argType = getExprType(argExpr);
      if (argType?.isTupleType()) {
        argElems = argType.value;
      }
    }

    if (argElems) {
      for (let i = 0; i < typeElems.length && i < argElems.length; i++) {
        const match = findMatchingExpr(typeElems[i], argElems[i], tp);
        if (match) return match;
      }
    }
  }

  // Object type fields
  if (typeExpr.isObjectType()) {
    let argFields: { name: string; expr: Expr }[] | undefined;

    if (argExpr.isObjectLiteral()) {
      argFields = argExpr.fields.map((f) => ({
        name: f.name,
        expr: f.initializer,
      }));
    } else {
      const argType = getExprType(argExpr);
      if (argType?.isObjectType()) {
        argFields = argType.fields.map((f) => ({
          name: f.name,
          expr: f.typeExpr,
        }));
      }
    }

    if (argFields) {
      for (const field of typeExpr.fields) {
        const argField = argFields.find((f) => f.name === field.name);
        if (argField) {
          const match = findMatchingExpr(field.typeExpr, argField.expr, tp);
          if (match) return match;
        }
      }
    }
  }

  return undefined;
};

export const inferTypeArgs = (
  typeParams: Identifier[] | undefined,
  pairs: TypeArgInferencePair[]
): List | undefined => {
  if (!typeParams?.length) return;

  const inferred: Type[] = [];

  for (const tp of typeParams) {
    let inferredType: Type | undefined;

    for (const { typeExpr, argExpr } of pairs) {
      const match = findMatchingExpr(typeExpr, argExpr, tp);
      if (!match) continue;

      resolveTypeExpr(match);
      const type = getExprType(match);
      if (!type) continue;

      inferredType = new TypeAlias({ name: tp.clone(), typeExpr: nop() });
      inferredType.type = type;
      break;
    }

    if (!inferredType) return undefined;

    inferred.push(inferredType);
  }

  return new List({ value: inferred });
};
