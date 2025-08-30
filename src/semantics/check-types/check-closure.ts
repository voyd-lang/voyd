import { Closure } from "../../syntax-objects/closure.js";
import { Expr } from "../../syntax-objects/expr.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkParameters } from "./check-parameters.js";
import { checkTypes } from "./check-types.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkClosureTypes = (closure: Closure): Closure => {
  checkParameters(closure.parameters);
  checkTypes(closure.body);

  // Disallow direct assignment to captured outer variables from within the
  // closure body. This currently leads to invalid local index generation at
  // codegen time. Recommend mutating a field on an object wrapper instead.
  assertNoCapturedOuterVarAssignment(closure);

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

const assertNoCapturedOuterVarAssignment = (closure: Closure) => {
  if (!closure.captures.length) return;
  const captured = new Set(closure.captures.map((c) => c.id));

  const visit = (expr: Expr | undefined): void => {
    if (!expr) return;
    if (expr.isClosure()) return; // nested closures are checked independently

    if (expr.isBlock()) {
      expr.body.forEach(visit);
      return;
    }

    if (expr.isMatch()) {
      visit(expr.operand);
      expr.cases.forEach((c) => visit(c.expr));
      if (expr.defaultCase) visit(expr.defaultCase.expr);
      return;
    }

    if (expr.isCall()) {
      if (expr.calls("=")) {
        const lhs = expr.argAt(0);
        if (lhs?.isIdentifier()) {
          const entity = lhs.resolve();
          if (
            (entity?.isVariable?.() || entity?.isParameter?.()) &&
            captured.has(entity.id)
          ) {
            throw new Error(
              `Cannot assign to captured variable ${lhs} inside closure at ${lhs.location}. Wrap the state in an object and mutate a field instead (e.g. { val } and then state.val = …).`
            );
          }
        }
      }
      expr.args.each((a) => visit(a));
      return;
    }
  };

  visit(closure.body);
};
