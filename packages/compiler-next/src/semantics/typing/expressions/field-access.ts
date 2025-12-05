import type { HirFieldAccessExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { getStructuralFields } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";
import { assertFieldAccess } from "../visibility.js";

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
    throw new Error(`object type is missing field ${expr.field}`);
  }

  assertFieldAccess({
    field,
    ctx,
    state,
    span: expr.span,
    context: "accessing member",
  });
  return field.type;
};
