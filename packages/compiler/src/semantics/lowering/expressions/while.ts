import type { Form } from "../../../parser/index.js";
import { expectLabeledExpr, toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { LoweringFormParams } from "./types.js";

export const lowerWhile = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error("while expression missing condition");
  }

  const bodyExpr = expectLabeledExpr(form.at(2), "do", "while expression");

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
