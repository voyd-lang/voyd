import type { HirExpression } from "../../hir/index.js";
import type { HirExprId, TypeId } from "../ids.js";
import { typeExpression } from "../expressions.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const fields = expr.elements.map((elementId, index) => ({
    name: `${index}`,
    type: typeExpression(elementId, ctx, state),
  }));
  return ctx.arena.internStructuralObject({ fields });
};
