import { type Form, isForm } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { HirPattern } from "../../hir/index.js";
import { lowerPattern } from "./patterns.js";
import type { LoweringFormParams } from "./types.js";

export const lowerAssignment = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const targetExpr = form.at(1);
  const valueExpr = form.at(2);
  if (!targetExpr || !valueExpr) {
    throw new Error("assignment requires target and value");
  }

  let target: HirExprId | undefined;
  let pattern: HirPattern | undefined;

  if (
    isForm(targetExpr) &&
    (targetExpr.calls("tuple") || targetExpr.callsInternal("tuple"))
  ) {
    pattern = lowerPattern(targetExpr, ctx, scopes);
  } else {
    target = lowerExpr(targetExpr, ctx, scopes);
  }

  const value = lowerExpr(valueExpr, ctx, scopes);

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "assign",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    target,
    pattern,
    value,
  });
};
