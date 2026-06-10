import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ContinuationBinding,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
} from "../../context.js";
import { callRef, refCast } from "@voyd-lang/lib/binaryen-gc/index.js";
import { boxOutcomeValue } from "../outcome-values.js";
import { coerceValueToType } from "../../structural.js";
import { getRequiredExprType, wasmTypeFor } from "../../types.js";
import { functionRefType } from "./shared.js";
import { RESUME_KIND } from "../runtime-abi.js";
import { allocateTempLocal } from "../../locals.js";

export const compileContinuationCall = ({
  expr,
  continuation,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  continuation: ContinuationBinding;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const resumeTypeId = continuation.resumeTypeId;
  const resumeWasmType = wasmTypeFor(resumeTypeId, ctx);
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callReturnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  if (!fnCtx.effectful) {
    throw new Error("continuation calls are only supported in effectful contexts");
  }
  if (resumeWasmType === binaryen.none && expr.args.length > 0) {
    throw new Error("continuation does not take a value");
  }
  if (resumeWasmType !== binaryen.none && expr.args.length === 0) {
    throw new Error("continuation call requires a value");
  }
  const args =
    resumeWasmType === binaryen.none
      ? []
      : expr.args.map((arg, index) => {
          if (index > 0) {
            throw new Error("continuation calls accept at most one argument");
          }
          const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
          const previousSuppressTailChecks = fnCtx.suppressTailResumptionExitChecks;
          fnCtx.suppressTailResumptionExitChecks =
            continuation.resumeKind === RESUME_KIND.tail ||
            previousSuppressTailChecks === true;
          const value = (() => {
            try {
              return compileExpr({ exprId: arg.expr, ctx, fnCtx });
            } finally {
              fnCtx.suppressTailResumptionExitChecks = previousSuppressTailChecks;
            }
          })();
          return coerceValueToType({
            value: value.expr,
            actualType: actualTypeId,
            targetType: resumeTypeId,
            ctx,
            fnCtx,
          });
        });

  const guardRef = ctx.mod.local.get(
    continuation.tailGuardLocal.index,
    continuation.tailGuardLocal.type
  );
  const contRef = ctx.mod.local.get(
    continuation.continuationLocal.index,
    continuation.continuationLocal.type
  );
  const guardOps: binaryen.ExpressionRef[] = [
    ctx.mod.if(
      ctx.mod.i32.ge_u(
        ctx.effectsRuntime.tailGuardObserved(guardRef),
        ctx.effectsRuntime.tailGuardExpected(guardRef)
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop()
    ),
    ctx.effectsRuntime.bumpTailGuardObserved(guardRef),
  ];

  const resumeBoxValue =
    resumeWasmType === binaryen.none
      ? ctx.mod.ref.null(binaryen.eqref)
      : boxOutcomeValue({
          value: args[0]!,
          valueType: resumeWasmType,
          typeId: resumeTypeId,
          ctx,
          fnCtx,
        });
  const resumeBoxLocal =
    resumeWasmType === binaryen.none
      ? undefined
      : allocateTempLocal(binaryen.eqref, fnCtx, ctx.program.primitives.unknown, ctx);
  const resumeBox = resumeBoxLocal
    ? ctx.mod.local.get(resumeBoxLocal.index, resumeBoxLocal.type)
    : resumeBoxValue;
  const callArgs = [ctx.effectsRuntime.continuationEnv(contRef), resumeBox];
  const fnRefType = functionRefType({
    params: [binaryen.anyref, binaryen.eqref],
    result: ctx.effectsRuntime.outcomeType,
    ctx,
  });
  const continuationCall = callRef(
    ctx.mod,
    refCast(ctx.mod, ctx.effectsRuntime.continuationFn(contRef), fnRefType),
    callArgs as number[],
    ctx.effectsRuntime.outcomeType
  );
  const callExpr =
    guardOps.length === 0 && !resumeBoxLocal
      ? continuationCall
      : ctx.mod.block(
          null,
          [
            ...(resumeBoxLocal
              ? [
                  ctx.mod.local.set(
                    resumeBoxLocal.index,
                    resumeBoxValue,
                  ),
                ]
              : []),
            ...guardOps,
            continuationCall,
          ],
          ctx.effectsRuntime.outcomeType,
        );

  // Semantics: calling a resumption does not return to the handler clause body.
  return {
    expr: ctx.mod.block(
      null,
      [ctx.mod.return(callExpr), ctx.mod.unreachable()],
      wasmTypeFor(callReturnTypeId, ctx)
    ),
    usedReturnCall: false,
  };
};
