import type { HirAssignExpr, HirPattern } from "../../hir/index.js";
import type { HirExprId, SourceSpan, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import {
  bindTuplePatternFromExpr,
  bindTuplePatternFromType,
} from "./patterns.js";
import {
  assertMutableBinding,
  assertMutableObjectBinding,
  findBindingSymbol,
} from "./mutability.js";
import { ensureTypeMatches, resolveTypeExpr } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeAssignExpr = (
  expr: HirAssignExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  if (expr.pattern) {
    const effectRow = typeTupleAssignment(
      expr.pattern,
      expr.value,
      ctx,
      state,
      expr.span
    );
    ctx.effects.setExprEffect(expr.id, effectRow);
    return ctx.primitives.void;
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetExpr = ctx.hir.expressions.get(expr.target);
  const targetSpan = targetExpr?.span ?? expr.span;
  if (targetExpr?.exprKind === "identifier") {
    assertMutableBinding({
      symbol: targetExpr.symbol,
      span: targetSpan,
      ctx,
    });
  }
  if (targetExpr?.exprKind === "field-access") {
    const symbol = findBindingSymbol(targetExpr.target, ctx);
    if (typeof symbol === "number") {
      assertMutableObjectBinding({
        symbol,
        span: targetSpan,
        ctx,
        reason: "cannot assign to field of immutable object",
      });
    }
  }

  const targetType = typeExpression(expr.target, ctx, state);
  const valueType = typeExpression(expr.value, ctx, state, targetType);
  ensureTypeMatches(valueType, targetType, ctx, state, "assignment target");
  const effectRow = composeEffectRows(ctx.effects, [
    getExprEffectRow(expr.target, ctx),
    getExprEffectRow(expr.value, ctx),
  ]);
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.primitives.void;
};

const typeTupleAssignment = (
  pattern: HirPattern,
  valueExpr: HirExprId,
  ctx: TypingContext,
  state: TypingState,
  assignmentSpan: SourceSpan
): number => {
  if (pattern.kind !== "tuple") {
    throw new Error("tuple assignment requires a tuple pattern");
  }
  const annotated =
    pattern.typeAnnotation &&
    resolveTypeExpr(
      pattern.typeAnnotation,
      ctx,
      state,
      ctx.primitives.unknown
    );
  if (typeof annotated === "number" && annotated !== ctx.primitives.unknown) {
    const valueType = typeExpression(valueExpr, ctx, state, annotated);
    if (valueType !== ctx.primitives.unknown) {
      ensureTypeMatches(
        valueType,
        annotated,
        ctx,
        state,
        "tuple assignment"
      );
    }
    bindTuplePatternFromType(
      pattern,
      annotated,
      ctx,
      state,
      "assign",
      assignmentSpan
    );
    return getExprEffectRow(valueExpr, ctx);
  }
  bindTuplePatternFromExpr(
    pattern,
    valueExpr,
    ctx,
    state,
    "assign",
    assignmentSpan
  );
  return getExprEffectRow(valueExpr, ctx);
};
