import { isForm, type Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import { resolveSymbol } from "../resolution.js";
import type { LoweringFormParams } from "./types.js";
import { GENERATED_ARRAY_LITERAL_HELPER } from "../../generated-syntax-helpers.js";

export const isArrayLiteralForm = (form: Form): boolean =>
  form.callsInternal("array_literal") || form.callsInternal("new_array_unchecked");

export const lowerArrayLiteralExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const fixedArrayCallee = resolveSymbol("fixed_array_literal", scopes.current(), ctx);
  const fixedArrayCalleeExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "identifier",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    symbol: fixedArrayCallee,
  });

  const fixedArrayArgs =
    form.callsInternal("array_literal")
      ? form.rest.map((entry) => ({
          expr: lowerExpr(entry, ctx, scopes),
        }))
      : extractGeneratedArrayPayloadArgs({ form, ctx, scopes, lowerExpr });

  const fixedArrayCall = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: fixedArrayCalleeExpr,
    args: fixedArrayArgs,
  });

  const helperSymbol =
    ctx.symbolTable.resolve(GENERATED_ARRAY_LITERAL_HELPER, scopes.current()) ??
    resolveSymbol("new_array_unchecked", scopes.current(), ctx);

  const helperCalleeExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "identifier",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    symbol: helperSymbol,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: helperCalleeExpr,
    args: [{ label: "from", expr: fixedArrayCall }],
  });
};

const extractGeneratedArrayPayloadArgs = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): Array<{ expr: HirExprId }> => {
  const fromArg = form.at(1);
  if (!isForm(fromArg) || !fromArg.calls(":")) {
    throw new Error("generated array literal missing from label");
  }

  const payloadExpr = fromArg.at(2);
  if (!isForm(payloadExpr) || !payloadExpr.callsInternal("fixed_array_literal")) {
    throw new Error("generated array literal missing fixed_array payload");
  }

  return payloadExpr.rest.map((entry) => ({
    expr: lowerExpr(entry, ctx, scopes),
  }));
};
