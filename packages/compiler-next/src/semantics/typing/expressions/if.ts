import type { HirIfExpr } from "../../hir/index.js";
import { typeExpression } from "../expressions.js";
import type { TypingContext, TypingState } from "../types.js";
import { ensureTypeMatches } from "../type-system.js";
import { mergeBranchType } from "./branching.js";
import type { TypeId } from "../../ids.js";

export const typeIfExpr = (
  expr: HirIfExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const hasDefault = typeof expr.defaultBranch === "number";
  let branchType: TypeId | undefined;

  expr.branches.forEach((branch, index) => {
    const conditionType = typeExpression(branch.condition, ctx, state);
    ensureTypeMatches(
      conditionType,
      ctx.primitives.bool,
      ctx,
      state,
      `if condition ${index + 1}`
    );

    const valueType = typeExpression(branch.value, ctx, state);
    branchType = mergeBranchType({
      acc: branchType,
      next: valueType,
      ctx,
      state,
    });
  });

  if (hasDefault) {
    const defaultType = typeExpression(expr.defaultBranch!, ctx, state);
    branchType = mergeBranchType({
      acc: branchType,
      next: defaultType,
      ctx,
      state,
    });
    return branchType ?? ctx.primitives.void;
  }

  return ctx.primitives.void;
};
