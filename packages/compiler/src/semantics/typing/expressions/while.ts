import type { HirWhileExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import { ensureTypeMatches } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeWhileExpr = (
  expr: HirWhileExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const conditionType = typeExpression(expr.condition, ctx, state);
  const conditionSpan = ctx.hir.expressions.get(expr.condition)?.span ?? expr.span;
  ensureTypeMatches(
    conditionType,
    ctx.primitives.bool,
    ctx,
    state,
    "while condition",
    conditionSpan,
  );
  typeExpression(expr.body, ctx, state, { discardValue: true });
  const effectRow = composeEffectRows(ctx.effects, [
    getExprEffectRow(expr.condition, ctx),
    getExprEffectRow(expr.body, ctx),
  ]);
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.primitives.void;
};
