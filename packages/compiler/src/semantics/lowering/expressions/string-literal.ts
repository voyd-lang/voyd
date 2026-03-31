import type { Form } from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import type { LowerContext, LowerScopeStack } from "../types.js";
import { toSourceSpan } from "../../utils.js";
import { GENERATED_STRING_LITERAL_HELPER } from "../../string-literal-helper.js";

export const isGeneratedStringLiteralForm = (form: Form): boolean =>
  form.callsInternal("new_string");

export const lowerGeneratedStringLiteralExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: {
  form: Form;
  ctx: LowerContext;
  scopes: LowerScopeStack;
  lowerExpr: (expr: Form["first"], ctx: LowerContext, scopes: LowerScopeStack) => HirExprId;
}): HirExprId | undefined => {
  const helperSymbol = ctx.symbolTable.resolve(
    GENERATED_STRING_LITERAL_HELPER,
    scopes.current(),
  );
  const payloadExpr = form.at(1);
  if (typeof helperSymbol !== "number" || !payloadExpr) {
    return undefined;
  }

  const callee = ctx.builder.addExpression({
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
    callee,
    args: [{ expr: lowerExpr(payloadExpr, ctx, scopes) }],
  });
};
