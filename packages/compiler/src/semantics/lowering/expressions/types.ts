import type { Expr, Form } from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import type { LowerContext, LowerScopeStack } from "../types.js";

export type LowerExprFn = (
  expr: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
) => HirExprId;

export type LoweringParams = {
  ctx: LowerContext;
  scopes: LowerScopeStack;
  lowerExpr: LowerExprFn;
};

export type LoweringFormParams = LoweringParams & {
  form: Form;
};
