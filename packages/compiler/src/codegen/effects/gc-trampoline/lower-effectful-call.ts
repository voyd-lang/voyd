import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  FunctionContext,
  HirExprId,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { ContinuationCallSite } from "../effect-lowering.js";
import { ensureDispatcher } from "../dispatcher.js";
import { handlerCleanupOps } from "../handler-stack.js";
import { wrapRequestContinuationWithFrame } from "../continuation-bind.js";
import { OUTCOME_TAGS } from "../runtime-abi.js";
import { unboxOutcomeValue } from "../outcome-values.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadBindingValue,
} from "../../locals.js";
import { getExprBinaryenType, wasmTypeFor } from "../../types.js";
import { currentHandlerValue } from "./shared.js";
import { ensureContinuationFunction } from "./continuations.js";
import { initStruct, refCast, refFunc } from "@voyd/lib/binaryen-gc/index.js";

export const lowerEffectfulCallResult = ({
  callExpr,
  callId,
  returnTypeId,
  expectedResultTypeId,
  tailPosition,
  typeInstanceId,
  ctx,
  fnCtx,
}: {
  callExpr: binaryen.ExpressionRef;
  callId: HirExprId;
  returnTypeId: TypeId;
  expectedResultTypeId?: TypeId;
  tailPosition: boolean;
  typeInstanceId?: ProgramFunctionInstanceId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): CompiledExpression => {
  const lookupKey = typeInstanceId ?? fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const valueType = wasmTypeFor(returnTypeId, ctx);
  const outcomeTemp = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(outcomeTemp.index, callExpr)];

  const loadOutcome = () =>
    ctx.mod.local.get(outcomeTemp.index, ctx.effectsRuntime.outcomeType);
  const maybeDispatchEffect = ctx.mod.i32.eq(
    ctx.effectsRuntime.outcomeTag(loadOutcome()),
    ctx.mod.i32.const(OUTCOME_TAGS.effect)
  );
  ops.push(
    ctx.mod.if(
      maybeDispatchEffect,
      ctx.mod.local.set(
        outcomeTemp.index,
        ctx.mod.call(ensureDispatcher(ctx), [loadOutcome()], ctx.effectsRuntime.outcomeType)
      ),
      ctx.mod.nop()
    )
  );

  const tagIsValue = ctx.mod.i32.eq(
    ctx.effectsRuntime.outcomeTag(loadOutcome()),
    ctx.mod.i32.const(OUTCOME_TAGS.value)
  );
  const payload = ctx.effectsRuntime.outcomePayload(loadOutcome());
  const valueResult = unboxOutcomeValue({ payload, valueType, ctx });

  const effectReturn = fnCtx.effectful
    ? (() => {
        const cleanup = handlerCleanupOps({ ctx, fnCtx });
        const site = !tailPosition ? ctx.effectLowering.sitesByExpr.get(callId) : undefined;
        const shouldWrap = !!site && site.kind === "call" && !tailPosition;

        if (!shouldWrap) {
          const ret = ctx.mod.return(loadOutcome());
          return cleanup.length === 0 ? ret : ctx.mod.block(null, [...cleanup, ret], binaryen.none);
        }

        const callSite = site as ContinuationCallSite;
        const frameEnvValues = callSite.envFields.map((field) => {
          switch (field.sourceKind) {
            case "site":
              return ctx.mod.i32.const(callSite.siteOrder);
            case "handler":
              return currentHandlerValue(ctx, fnCtx);
            case "param":
            case "local": {
              if (typeof field.tempId === "number") {
                const binding = fnCtx.tempLocals.get(field.tempId);
                if (!binding) {
                  throw new Error("missing temp local binding for call env capture");
                }
                return ctx.mod.local.get(binding.index, binding.type);
              }
              if (typeof field.symbol !== "number") {
                throw new Error("missing symbol for env field");
              }
              const binding = getRequiredBinding(field.symbol, ctx, fnCtx);
              return loadBindingValue(binding, ctx);
            }
          }
        });

        const contRefType = ensureContinuationFunction({
          site: callSite,
          ctx,
          typeInstanceId: lookupKey,
        });
        const frameEnv = initStruct(ctx.mod, callSite.envType, frameEnvValues as number[]);
        const frameCont = ctx.effectsRuntime.makeContinuation({
          fnRef: refFunc(ctx.mod, callSite.contFnName, contRefType),
          env: frameEnv,
          site: ctx.mod.i32.const(callSite.siteOrder),
        });

        const request = refCast(
          ctx.mod,
          ctx.effectsRuntime.outcomePayload(loadOutcome()),
          ctx.effectsRuntime.effectRequestType
        );
        const wrappedRequest = wrapRequestContinuationWithFrame({ ctx, request, frame: frameCont });
        const wrappedOutcome = ctx.effectsRuntime.makeOutcomeEffect(wrappedRequest);

        const wrappedLocal = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
        const wrappedOps = [
          ctx.mod.local.set(wrappedLocal.index, wrappedOutcome),
          ...cleanup,
          ctx.mod.return(ctx.mod.local.get(wrappedLocal.index, wrappedLocal.type)),
        ];
        return ctx.mod.block(null, wrappedOps, binaryen.none);
      })()
    : ctx.mod.unreachable();

  if (valueType === binaryen.none) {
    ops.push(ctx.mod.if(tagIsValue, valueResult, effectReturn));
    return {
      expr: ctx.mod.block(null, ops, getExprBinaryenType(callId, ctx, lookupKey)),
      usedReturnCall: false,
    };
  }

  const resultTemp = allocateTempLocal(valueType, fnCtx);
  ops.push(
    ctx.mod.if(tagIsValue, ctx.mod.local.set(resultTemp.index, valueResult), effectReturn),
    ctx.mod.local.get(resultTemp.index, valueType)
  );

  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(callId, ctx, lookupKey)),
    usedReturnCall: false,
  };
};
