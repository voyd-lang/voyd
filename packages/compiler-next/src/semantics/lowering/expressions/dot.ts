import {
  type Expr,
  type Form,
  formCallsInternal,
  isForm,
} from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import { lowerCallFromElements } from "./call.js";
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
  const potentialGenerics = elements[1];
  const hasGenerics =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const argsStartIndex = hasGenerics ? 2 : 1;
  const args = elements.slice(argsStartIndex);
  const callArgs: Expr[] = hasGenerics
    ? [potentialGenerics!, targetExpr, ...args]
    : [targetExpr, ...args];

  return lowerCallFromElements({
    calleeExpr,
    argsExprs: callArgs,
    ast: dotForm,
    ctx,
    scopes,
    lowerExpr,
  });
};
