import { Closure } from "../../syntax-objects/closure.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkParameters } from "./check-parameters.js";
import { checkTypes } from "./check-types.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkClosureTypes = (closure: Closure): Closure => {
  checkParameters(closure.parameters);
  checkTypes(closure.body);

  if (closure.returnTypeExpr) {
    checkTypeExpr(closure.returnTypeExpr);
  }

  if (!closure.returnType) {
    throw new Error(
      `Unable to determine return type for closure at ${closure.location}`
    );
  }

  const inferredReturnType = closure.inferredReturnType;

  if (
    inferredReturnType &&
    !typesAreCompatible(inferredReturnType, closure.returnType)
  ) {
    throw new Error(
      `Closure return value type (${inferredReturnType?.name}) is not compatible with annotated return type (${closure.returnType?.name}) at ${closure.location}`
    );
  }

  return closure;
};

