import type binaryen from "binaryen";
import type { HirExprId } from "../../semantics/ids.js";
import type { CodegenContext, FunctionContext } from "../context.js";
import type { HirEffectHandlerClause } from "../../semantics/hir/index.js";
import { RESUME_KIND } from "./runtime-abi.js";

export const getTailResumptionPlan = (
  clauseBody: HirExprId,
  ctx: CodegenContext
): HirEffectHandlerClause["tailResumption"] | undefined =>
  ctx.module.types.getTailResumption(clauseBody);

export const needsTailGuard = (
  clauseBody: HirExprId,
  ctx: CodegenContext
): boolean => getTailResumptionPlan(clauseBody, ctx)?.enforcement === "runtime";

export const tailResumptionExitChecks = ({
  ctx,
  fnCtx,
}: {
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  const continuations = fnCtx.continuations
    ? [...fnCtx.continuations.values()]
    : [];
  if (continuations.length === 0) {
    return [];
  }

  return continuations
    .filter((continuation) => continuation.resumeKind === RESUME_KIND.tail)
    .map((continuation) => {
      const guard = ctx.mod.local.get(
        continuation.tailGuardLocal.index,
        continuation.tailGuardLocal.type
      );
      return ctx.mod.if(
        ctx.mod.i32.ne(
          ctx.effectsRuntime.tailGuardObserved(guard),
          ctx.effectsRuntime.tailGuardExpected(guard)
        ),
        ctx.mod.unreachable(),
        ctx.mod.nop()
      );
    });
};
