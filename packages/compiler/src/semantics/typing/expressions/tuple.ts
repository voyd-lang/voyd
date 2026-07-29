import type { HirExpression } from "../../hir/index.js";
import type { HirExprId, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import {
  getStructuralFields,
  typeSatisfiesBorrowFormation,
} from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId,
): TypeId => {
  const expectedFields =
    typeof expectedType === "number" && expectedType !== ctx.primitives.unknown
      ? getStructuralFields(expectedType, ctx, state)
      : undefined;
  const fields = expr.elements.map((elementId, index) => {
    const expectedField = expectedFields?.find(
      (field) => field.name === `${index}`,
    );
    const elementType = typeExpression(elementId, ctx, state, {
      expectedType: expectedField?.type,
    });
    return {
      name: `${index}`,
      type:
        expectedField &&
        typeSatisfiesBorrowFormation(
          elementType,
          expectedField.type,
          ctx,
          state,
        )
          ? expectedField.type
          : elementType,
    };
  });
  const effectRow = composeEffectRows(
    ctx.effects,
    expr.elements.map((elementId) => getExprEffectRow(elementId, ctx)),
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.arena.internStructuralObject({ fields });
};
