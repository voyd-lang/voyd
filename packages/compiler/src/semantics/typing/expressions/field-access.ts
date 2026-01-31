import type { HirFieldAccessExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { getStructuralFields } from "../type-system.js";
import { getExprEffectRow } from "../effects.js";
import type { TypingContext, TypingState } from "../types.js";
import { assertFieldAccess } from "../visibility.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";

export const typeFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const targetType = typeExpression(expr.target, ctx, state);
  if (targetType === ctx.primitives.unknown) {
    return ctx.primitives.unknown;
  }

  const fields = getStructuralFields(targetType, ctx, state, {
    includeInaccessible: true,
  });
  if (!fields) {
    throw new Error("field access requires an object type");
  }

  const field = fields.find((candidate) => candidate.name === expr.field);
  if (!field) {
    if (state.mode === "relaxed") {
      return ctx.primitives.unknown;
    }
    const tupleInfo = inferTupleFieldInfo(fields);
    if (tupleInfo && isTupleIndex(expr.field) && tupleInfo.length <= Number(expr.field)) {
      return emitDiagnostic({
        ctx,
        code: "TY0032",
        params: {
          kind: "tuple-index-out-of-range",
          index: Number(expr.field),
          length: tupleInfo.length,
        },
        span: normalizeSpan(expr.span),
      });
    }
    return emitDiagnostic({
      ctx,
      code: "TY0033",
      params: { kind: "unknown-field", name: expr.field },
      span: normalizeSpan(expr.span),
    });
  }

  assertFieldAccess({
    field,
    ctx,
    state,
    span: expr.span,
    context: "accessing member",
  });
  ctx.effects.setExprEffect(expr.id, getExprEffectRow(expr.target, ctx));
  return field.type;
};

const isTupleIndex = (field: string): boolean => /^\d+$/.test(field);

const inferTupleFieldInfo = (
  fields: readonly { name: string }[]
): { length: number } | undefined => {
  if (fields.length === 0) return undefined;
  const names = fields.map((field) => field.name);
  if (!names.every(isTupleIndex)) return undefined;
  const indices = names.map((name) => Number(name));
  if (!indices.every((index) => Number.isSafeInteger(index) && index >= 0)) {
    return undefined;
  }
  const max = Math.max(...indices);
  const expected = max + 1;
  const set = new Set(indices);
  for (let index = 0; index < expected; index += 1) {
    if (!set.has(index)) return undefined;
  }
  return { length: expected };
};
