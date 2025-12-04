import { type Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import { resolveSymbol } from "../resolution.js";
import type { LoweringFormParams } from "./types.js";

export const isArrayLiteralForm = (form: Form): boolean =>
  form.callsInternal("array_literal");

export const lowerArrayLiteralExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const callee = resolveSymbol("fixed_array_literal", scopes.current(), ctx);
  const calleeExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "identifier",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    symbol: callee,
  });

  const args = form.rest.map((entry) => ({
    expr: lowerExpr(entry, ctx, scopes),
  }));

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: calleeExpr,
    args,
  });
};
