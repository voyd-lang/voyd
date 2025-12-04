import type { HirWhileExpr } from "../../hir/index.js";
import type { TypeId } from "../ids.js";
import { typeExpression } from "../expressions.js";
import { ensureTypeMatches } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeWhileExpr = (
  expr: HirWhileExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const conditionType = typeExpression(expr.condition, ctx, state);
  ensureTypeMatches(
    conditionType,
    ctx.primitives.bool,
    ctx,
    state,
    "while condition"
  );
  typeExpression(expr.body, ctx, state);
  return ctx.primitives.void;
};
