import type binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  FunctionContext,
  FunctionMetadata,
  HirExprId,
} from "../../context.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  wasmTypeFor,
} from "../../types.js";
import { requiresStructuralConversion } from "../../structural.js";
import { currentHandlerValue } from "./shared.js";

export const emitResolvedCall = ({
  meta,
  args,
  callId,
  ctx,
  fnCtx,
  options = {},
}: {
  meta: FunctionMetadata;
  args: readonly binaryen.ExpressionRef[];
  callId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  options?: CompileCallOptions;
}): CompiledExpression => {
  const {
    tailPosition = false,
    expectedResultTypeId,
    typeInstanceId,
  } = options;

  const lookupKey = typeInstanceId ?? meta.instanceId;
  const returnTypeId = getRequiredExprType(callId, ctx, lookupKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const callResultWasmType = getExprBinaryenType(callId, ctx, lookupKey);
  const callerReturnWasmType =
    fnCtx.returnWasmType ?? wasmTypeFor(fnCtx.returnTypeId, ctx);

  const callArgs = meta.effectful
    ? [currentHandlerValue(ctx, fnCtx), ...args]
    : args;

  if (meta.effectful) {
    const callExpr = ctx.mod.call(
      meta.wasmName,
      callArgs as number[],
      meta.resultType
    );
    return ctx.effectsBackend.lowerEffectfulCallResult({
      callExpr,
      callId,
      returnTypeId,
      expectedResultTypeId,
      tailPosition,
      typeInstanceId,
      ctx,
      fnCtx,
    });
  }

  const allowReturnCall =
    tailPosition &&
    !fnCtx.effectful &&
    meta.resultTypeId === expectedTypeId &&
    returnTypeId === expectedTypeId &&
    meta.resultType === callerReturnWasmType &&
    callResultWasmType === callerReturnWasmType &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx);

  if (allowReturnCall) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        callArgs as number[],
        callResultWasmType
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(meta.wasmName, callArgs as number[], callResultWasmType),
    usedReturnCall: false,
  };
};
