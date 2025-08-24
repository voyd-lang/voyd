import { Call } from "../../syntax-objects/call.js";
import { bool, dVoid } from "../../syntax-objects/index.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";

export const checkIf = (call: Call) => {
  const cond = checkTypes(call.argAt(0));
  const condType = getExprType(cond);
  if (!condType || !typesAreCompatible(condType, bool)) {
    throw new Error(
      `If conditions must resolve to a boolean at ${cond.location}`
    );
  }

  if (!call.type) {
    throw new Error(
      `Unable to determine return type of If at ${call.location}`
    );
  }

  const elseExpr = call.argAt(2) ? checkTypes(call.argAt(2)) : undefined;

  // Until unions are supported, return voyd if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const elseType = getExprType(elseExpr);

  if (!typesAreCompatible(elseType, call.type)) {
    throw new Error(
      `If condition clauses do not return same type at ${call.location}`
    );
  }

  return call;
};

