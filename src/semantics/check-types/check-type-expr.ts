import { Expr } from "../../syntax-objects/index.js";
import { checkTypes } from "./check-types.js";

export const checkTypeExpr = (expr?: Expr) => {
  if (!expr) return; // TODO: Throw error? We use nop instead of undefined now (but maybe not everywhere)

  if (expr.isCall() && !expr.type) {
    throw new Error(
      `Unable to fully resolve type at ${expr.location ?? expr.fnName.location}`
    );
  }

  if (expr.isCall() && hasTypeArgs(expr.type)) {
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
  if (type.isObjectType() && type.typeParameters) return true;

  return false;
};

