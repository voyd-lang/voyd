import type { HirBreakExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { getExprEffectRow } from "../effects.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeBreakExpr = (
  expr: HirBreakExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  if (typeof expr.value === "number") {
    typeExpression(expr.value, ctx, state);
    ctx.effects.setExprEffect(expr.id, getExprEffectRow(expr.value, ctx));
  } else {
    ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  }
  return ctx.primitives.void;
};

