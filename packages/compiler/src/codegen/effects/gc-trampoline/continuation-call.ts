import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ContinuationBinding,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  TypeId,
} from "../../context.js";
import { callRef, refCast } from "@voyd/lib/binaryen-gc/index.js";
import { boxOutcomeValue } from "../outcome-values.js";
import { coerceValueToType } from "../../structural.js";
import { getRequiredExprType, wasmTypeFor } from "../../types.js";
import { functionRefType } from "./shared.js";
import { lowerEffectfulCallResult } from "./lower-effectful-call.js";

export const compileContinuationCall = ({
  expr,
  continuation,
  ctx,
  fnCtx,
  compileExpr,
  expectedResultTypeId,
  tailPosition,
}: {
  expr: HirCallExpr;
  continuation: ContinuationBinding;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  expectedResultTypeId?: TypeId;
  tailPosition: boolean;
}): CompiledExpression => {
  const resumeTypeId = continuation.resumeTypeId;
  const resumeWasmType = wasmTypeFor(resumeTypeId, ctx);
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callReturnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
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
          const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
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

  const resumeBox =
    resumeWasmType === binaryen.none
      ? ctx.mod.ref.null(binaryen.eqref)
      : boxOutcomeValue({
          value: args[0]!,
          valueType: resumeWasmType,
          ctx,
        });
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
    guardOps.length === 0
      ? continuationCall
      : ctx.mod.block(null, [...guardOps, continuationCall], ctx.effectsRuntime.outcomeType);

  return lowerEffectfulCallResult({
    callExpr,
    callId: expr.id,
    returnTypeId: callReturnTypeId,
    expectedResultTypeId,
    tailPosition,
    typeInstanceId,
    ctx,
    fnCtx,
  });
};
