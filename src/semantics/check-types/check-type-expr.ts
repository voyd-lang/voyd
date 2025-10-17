import { Expr, Identifier } from "../../syntax-objects/index.js";
import { checkTypes } from "./check-types.js";

export const checkTypeExpr = (expr?: Expr) => {
  if (!expr) return; // TODO: Throw error? We use nop instead of undefined now (but maybe not everywhere)

  if (expr.isCall() && !expr.type) {
    throw new Error(
      `Unable to fully resolve type at ${expr.location ?? expr.fnName.location}`
    );
  }

  if (expr.isCall() && hasTypeArgs(expr.type)) {
    // no-op
    throw new Error(
      `Type args must be resolved at ${expr.location ?? expr.fnName.location}`
    );
  }

  if (expr.isCall()) {
    return;
  }

  if (expr.isIdentifier() && !expr.is("self")) {
    const entity = expr.resolve();
    if (!entity) {
      throw new Error(`Unrecognized identifier ${expr} at ${expr.location}`);
    }

    if (!entity.isType()) {
      throw new Error(
        `Expected type, got ${entity.name.value} at ${expr.location}`
      );
    }

    if (hasTypeArgs(entity)) {
      throw new Error(
        `Type args must be resolved for ${entity.name} at ${expr.location}`
      );
    }
  }

  return checkTypes(expr);
};

const hasTypeArgs = (type?: Expr) => {
  if (!type) return false;

  if (type.isTypeAlias() && type.typeParameters) return true;
  if (type.isObjectType()) {
    // Consider an object type "resolved enough" when it has concrete applied
    // generic arguments. Only flag unresolved when type parameters exist and
    // no applied type args have been provided.
    if (!type.typeParameters) return false;
    return !(type.resolvedTypeArgs && type.resolvedTypeArgs.length > 0);
  }

  return false;
};

/**
 * Generic-safe variant for validating type expressions inside generic function
 * signatures. It permits unresolved type parameters (e.g., `T`) while still
 * erroring on truly unknown identifiers (e.g., misspelled `string`).
 */
export const checkTypeExprAllowTypeParams = (
  expr: Expr | undefined,
  allowedTypeParams: Set<string>
): void => {
  if (!expr) return;

  const visit = (e: Expr | undefined): void => {
    if (!e) return;

    // Identifiers: allow generic params, require others to resolve to a type
    if (e.isIdentifier()) {
      if (e.is("self")) return;
      if (allowedTypeParams.has((e as Identifier).value)) return;
      const entity = e.resolve();
      if (!entity) {
        throw new Error(`Unrecognized identifier ${e} at ${e.location}`);
      }
      if (!entity.isType()) {
        throw new Error(
          `Expected type, got ${entity.name.value} at ${e.location}`
        );
      }
      return;
    }

    // Type alias: validate underlying expression
    if (e.isTypeAlias()) {
      if (e.typeExpr) visit(e.typeExpr);
      return;
    }

    // Calls: validate type arguments but do not require full specialization
    if (e.isCall()) {
      if (e.typeArgs) e.typeArgs.toArray().forEach(visit);
      return;
    }

    // Object/tuple type: validate field types
    if (e.isObjectType()) {
      e.fields.forEach((f) => visit(f.typeExpr));
      if (e.parentObjExpr) visit(e.parentObjExpr);
      return;
    }

    // Fixed array: validate element type
    if (e.isFixedArrayType()) {
      visit(e.elemTypeExpr);
      return;
    }

    // Function type: validate param and return types
    if (e.isFnType()) {
      e.parameters.forEach((p) => p.typeExpr && visit(p.typeExpr));
      if (e.returnTypeExpr) visit(e.returnTypeExpr);
      return;
    }

    // Intersection and union: validate child expressions
    if (e.isIntersectionType()) {
      visit(e.nominalTypeExpr.value);
      visit(e.structuralTypeExpr.value);
      return;
    }
    if (e.isUnionType()) {
      e.memberTypeExprs.toArray().forEach(visit);
      return;
    }
  };

  visit(expr);
};
