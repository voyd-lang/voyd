import { Call } from "../../syntax-objects/call.js";
import { Expr, bool, dVoid } from "../../syntax-objects/index.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";

export const checkCond = (call: Call) => {
  const args = call.args.toArray();

  const branchExprs: Expr[] = [];
  let hasDefault = false;

  args.forEach((arg) => {
    if (arg.isObjectLiteral() && !arg.hasAttribute("condDefault")) {
      const cond = checkTypes(
        arg.fields.find((f) => f.name === "case")?.initializer
      );
      const condType = getExprType(cond);
      if (!cond || !condType || !typesAreCompatible(condType, bool)) {
        throw new Error(
          `Cond conditions must resolve to a boolean at ${cond?.location}`
        );
      }
      const thenExpr = arg.fields.find((f) => f.name === "do")?.initializer;
      if (thenExpr) branchExprs.push(checkTypes(thenExpr));
    } else {
      hasDefault = true;
      branchExprs.push(checkTypes(arg));
    }
  });

  if (!call.type) {
    throw new Error(`Unable to determine return type of cond at ${call.location}`);
  }

  if (!hasDefault) {
    call.type = dVoid;
    return call;
  }

  const expected = call.type;
  branchExprs.forEach((expr) => {
    const t = getExprType(expr);
    if (!typesAreCompatible(t, expected)) {
      throw new Error(
        `Cond condition clauses do not return same type at ${call.location}`
      );
    }
  });

  return call;
};
