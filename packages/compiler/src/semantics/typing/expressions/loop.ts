import type { HirLoopExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { getExprEffectRow } from "../effects.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeLoopExpr = (
  expr: HirLoopExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  typeExpression(expr.body, ctx, state, { discardValue: true });
  ctx.effects.setExprEffect(expr.id, getExprEffectRow(expr.body, ctx));
  return ctx.primitives.void;
};
