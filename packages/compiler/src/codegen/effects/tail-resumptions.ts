import type { HirExprId } from "../../semantics/ids.js";
import type { CodegenContext } from "../context.js";
import type { HirEffectHandlerClause } from "../../semantics/hir/index.js";

export const getTailResumptionPlan = (
  clauseBody: HirExprId,
  ctx: CodegenContext
): HirEffectHandlerClause["tailResumption"] | undefined =>
  ctx.module.types.getTailResumption(clauseBody);

export const needsTailGuard = (
  clauseBody: HirExprId,
  ctx: CodegenContext
): boolean => getTailResumptionPlan(clauseBody, ctx)?.enforcement === "runtime";
