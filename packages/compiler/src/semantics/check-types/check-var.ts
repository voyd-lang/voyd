import { Variable } from "../../syntax-objects/variable.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkVarTypes = (variable: Variable): Variable => {
  checkTypes(variable.initializer);

  if (!variable.inferredType) {
    // Attempt a late type resolution in case upstream resolution left this
    // initializer partially unresolved (e.g., for control-flow sugar).
    const late = getExprType(variable.initializer);
    if (!late) {
      throw new Error(
        `Enable to determine variable initializer return type ${variable.name}`
      );
    }
    variable.inferredType = late;
  }

  if (variable.typeExpr) checkTypeExpr(variable.typeExpr);

  if (
    variable.annotatedType &&
    !typesAreCompatible(variable.inferredType, variable.annotatedType)
  ) {
    const annotatedName = variable.annotatedType.name.value;
    const inferredName = variable.inferredType.name.value;
    throw new Error(
      `${variable.name} is declared as ${annotatedName} but initialized with ${inferredName} at ${variable.location}`
    );
  }

  return variable;
};
