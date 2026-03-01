import type { HirIfExpr } from "../../hir/index.js";
import { typeExpression, type TypeExpressionOptions } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import type { TypingContext, TypingState } from "../types.js";
import { ensureTypeMatches } from "../type-system.js";
import { mergeBranchType } from "./branching.js";
import type { TypeId } from "../../ids.js";

export const typeIfExpr = (
  expr: HirIfExpr,
  ctx: TypingContext,
  state: TypingState,
  options: TypeExpressionOptions
): TypeId => {
  const hasDefault = typeof expr.defaultBranch === "number";
  const discardValue = options.discardValue === true || !hasDefault;
  let branchType: TypeId | undefined;
  let effectRow = ctx.effects.emptyRow;

  expr.branches.forEach((branch, index) => {
    const conditionType = typeExpression(branch.condition, ctx, state);
    const conditionSpan =
      ctx.hir.expressions.get(branch.condition)?.span ?? expr.span;
    ensureTypeMatches(
      conditionType,
      ctx.primitives.bool,
      ctx,
      state,
      `if condition ${index + 1}`,
      conditionSpan,
    );

    const valueType = typeExpression(branch.value, ctx, state, { discardValue });
    effectRow = ctx.effects.compose(
      effectRow,
      composeEffectRows(ctx.effects, [
        getExprEffectRow(branch.condition, ctx),
        getExprEffectRow(branch.value, ctx),
      ])
    );
    if (!discardValue) {
      branchType = mergeBranchType({
        acc: branchType,
        next: valueType,
        ctx,
        state,
        span: ctx.hir.expressions.get(branch.value)?.span,
        context: "if branch",
      });
    }
  });

  if (hasDefault) {
    const defaultType = typeExpression(expr.defaultBranch!, ctx, state, {
      discardValue,
    });
    effectRow = ctx.effects.compose(
      effectRow,
      getExprEffectRow(expr.defaultBranch!, ctx)
    );
    ctx.effects.setExprEffect(expr.id, effectRow);
    if (discardValue) {
      return ctx.primitives.void;
    }

    branchType = mergeBranchType({
      acc: branchType,
      next: defaultType,
      ctx,
      state,
      span: ctx.hir.expressions.get(expr.defaultBranch!)?.span,
      context: "if default branch",
    });
    return branchType ?? ctx.primitives.void;
  }

  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.primitives.void;
};
