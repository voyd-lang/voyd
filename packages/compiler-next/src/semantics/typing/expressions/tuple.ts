import type { HirExpression } from "../../hir/index.js";
import type { HirExprId, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
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
  const effectRow = composeEffectRows(
    ctx.effects,
    expr.elements.map((elementId) => getExprEffectRow(elementId, ctx))
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.arena.internStructuralObject({ fields });
};
