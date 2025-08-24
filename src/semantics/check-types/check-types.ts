import { Expr, nop } from "../../syntax-objects/index.js";

import { checkBlockTypes } from "./check-block.js";
import { checkCallTypes } from "./check-call.js";
import { checkFnTypes } from "./check-fn.js";
import { checkClosureTypes } from "./check-closure.js";
import { checkVarTypes } from "./check-var.js";
import { checkModuleTypes } from "./check-module.js";
import { checkListTypes } from "./check-list.js";
import { checkIdentifier } from "./check-identifier.js";
import { checkUse } from "./check-use.js";
import { checkObjectType } from "./check-object-type.js";
import { checkTypeAlias } from "./check-type-alias.js";
import { checkObjectLiteralType } from "./check-object-literal.js";
import { checkUnionType } from "./check-union-type.js";
import { checkFixedArrayType } from "./check-fixed-array-type.js";
import { checkMatch } from "./check-match.js";
import { checkIntersectionType } from "./check-intersection-type.js";

export const checkTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isBlock()) return checkBlockTypes(expr);
  if (expr.isCall()) return checkCallTypes(expr);
  if (expr.isFn()) return checkFnTypes(expr);
  if (expr.isClosure()) return checkClosureTypes(expr);
  if (expr.isVariable()) return checkVarTypes(expr);
  if (expr.isModule()) return checkModuleTypes(expr);
  if (expr.isList()) return checkListTypes(expr);
  if (expr.isIdentifier()) return checkIdentifier(expr);
  if (expr.isUse()) return checkUse(expr);
  if (expr.isObjectType()) return checkObjectType(expr);
  if (expr.isTypeAlias()) return checkTypeAlias(expr);
  if (expr.isObjectLiteral()) return checkObjectLiteralType(expr);
  if (expr.isUnionType()) return checkUnionType(expr);
  if (expr.isFixedArrayType()) return checkFixedArrayType(expr);
  if (expr.isMatch()) return checkMatch(expr);
  if (expr.isIntersectionType()) return checkIntersectionType(expr);
  return expr;
};
