import {
  type Expr,
  Form,
} from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import { toSourceSpan } from "../../utils.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";

export const isSubscriptForm = (form: Form): boolean =>
  form.callsInternal("subscript");

export const lowerSubscriptReadExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const receiverExpr = form.at(1);
  const indexExpr = form.at(2);
  if (!receiverExpr || !indexExpr) {
    throw new Error("subscript expression requires receiver and index");
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    target: lowerExpr(receiverExpr, ctx, scopes),
    method: "subscript_get",
    args: [{ expr: lowerExpr(indexExpr, ctx, scopes) }],
  });
};

export const lowerSubscriptSetExpr = ({
  assignmentForm,
  targetForm,
  valueExpr,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  assignmentForm: Form;
  targetForm: Form;
  valueExpr: Expr;
}): HirExprId => {
  const receiverExpr = targetForm.at(1);
  const indexExpr = targetForm.at(2);
  if (!receiverExpr || !indexExpr) {
    throw new Error("subscript assignment requires receiver and index");
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: assignmentForm.syntaxId,
    span: toSourceSpan(assignmentForm),
    target: lowerExpr(receiverExpr, ctx, scopes),
    method: "subscript_set",
    args: [
      { expr: lowerExpr(indexExpr, ctx, scopes) },
      { expr: lowerExpr(valueExpr, ctx, scopes) },
    ],
  });
};
