import type { HirContinueExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import type { TypingContext } from "../types.js";

export const typeContinueExpr = (expr: HirContinueExpr, ctx: TypingContext): TypeId => {
  ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  return ctx.primitives.void;
};

