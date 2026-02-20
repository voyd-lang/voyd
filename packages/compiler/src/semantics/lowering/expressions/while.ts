import { parseWhileConditionAndBody, toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { LoweringFormParams } from "./types.js";

export const lowerWhile = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const { condition: conditionExpr, body: bodyExpr } =
    parseWhileConditionAndBody(form);

  const condition = lowerExpr(conditionExpr, ctx, scopes);
  const body = lowerExpr(bodyExpr, ctx, scopes);

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "while",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    condition,
    body,
  });
};
