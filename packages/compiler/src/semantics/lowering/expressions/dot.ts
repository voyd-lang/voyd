import {
  type Expr,
  type Form,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import { toSourceSpan } from "../../utils.js";
import { lowerCallFromElements } from "./call.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { lowerMatch } from "./match.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";

export const lowerDotExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const targetExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!targetExpr || !memberExpr) {
    throw new Error("dot expression missing target or member");
  }

  if (isForm(memberExpr) && memberExpr.calls("match")) {
    return lowerMatch({
      form: memberExpr,
      ctx,
      scopes,
      lowerExpr,
      operandOverride: targetExpr,
    });
  }

  if (isForm(memberExpr) && memberExpr.calls("=>")) {
    return lowerCallFromElements({
      calleeExpr: memberExpr,
      argsExprs: [targetExpr],
      ast: form,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  if (isForm(memberExpr)) {
    return lowerMethodCallExpr({
      dotForm: form,
      memberForm: memberExpr,
      targetExpr,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  throw new Error("unsupported dot expression");
};

const lowerMethodCallExpr = ({
  dotForm,
  memberForm,
  targetExpr,
  ctx,
  scopes,
  lowerExpr,
}: {
  dotForm: Form;
  memberForm: Form;
  targetExpr: Expr;
} & LoweringParams): HirExprId => {
  const elements = memberForm.toArray();
  if (!elements.length) {
    throw new Error("method access missing callee");
  }

  const calleeExpr = elements[0]!;
  if (!isIdentifierAtom(calleeExpr) && !isInternalIdentifierAtom(calleeExpr)) {
    throw new Error("method name must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as HirTypeExpr[])
    : undefined;
  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    return { expr: lowerExpr(arg, ctx, scopes) };
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: dotForm.syntaxId,
    span: toSourceSpan(dotForm),
    target: lowerExpr(targetExpr, ctx, scopes),
    method: calleeExpr.value,
    args,
    typeArguments,
  });
};
