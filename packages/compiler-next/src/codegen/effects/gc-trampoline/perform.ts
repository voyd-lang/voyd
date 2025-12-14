import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  SymbolId,
} from "../../context.js";
import {
  initStruct,
  refFunc,
} from "@voyd/lib/binaryen-gc/index.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadBindingValue,
} from "../../locals.js";
import { coerceValueToType } from "../../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
} from "../../types.js";
import { handlerCleanupOps } from "../handler-stack.js";
import { currentHandlerValue } from "./shared.js";
import { ensureContinuationFunction } from "./continuations.js";

export const compileEffectOpCall = ({
  expr,
  calleeSymbol,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const site = ctx.effectLowering.sitesByExpr.get(expr.id);
  if (!site || site.kind !== "perform") {
    throw new Error("codegen missing effect lowering info for perform site");
  }
  const signature = ctx.typing.functions.getSignature(calleeSymbol);
  if (!signature) {
    throw new Error("codegen missing effect operation signature");
  }
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const args = expr.args.map((arg, index) => {
    const expectedTypeId = signature.parameters[index]?.type;
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });

  const envValues = site.envFields.map((field) => {
    switch (field.sourceKind) {
      case "site":
        return ctx.mod.i32.const(site.siteOrder);
      case "handler":
        return currentHandlerValue(ctx, fnCtx);
      case "param":
      case "local": {
        if (typeof field.tempId === "number") {
          const binding = fnCtx.tempLocals.get(field.tempId);
          if (!binding) {
            throw new Error("missing temp local binding for perform env capture");
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

  const contRefType = ensureContinuationFunction({ site, ctx });
  const env = initStruct(ctx.mod, site.envType, envValues as number[]);
  const contRef = refFunc(ctx.mod, site.contFnName, contRefType);
  const continuation = ctx.effectsRuntime.makeContinuation({
    fnRef: contRef,
    env,
    site: ctx.mod.i32.const(site.siteOrder),
  });
  const argsBoxed = site.argsType
    ? initStruct(ctx.mod, site.argsType, args as number[])
    : ctx.mod.ref.null(binaryen.eqref);
  const request = ctx.effectsRuntime.makeEffectRequest({
    effectId: ctx.mod.i32.const(site.effectId),
    opId: ctx.mod.i32.const(site.opId),
    resumeKind: ctx.mod.i32.const(site.resumeKind),
    args: argsBoxed,
    continuation,
    tailGuard: ctx.effectsRuntime.makeTailGuard(),
  });

  const exprRef = ctx.effectsRuntime.makeOutcomeEffect(request);

  if (!fnCtx.effectful) {
    return { expr: exprRef, usedReturnCall: false };
  }

  const cleanup = handlerCleanupOps({ ctx, fnCtx });
  const temp = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(temp.index, exprRef),
    ...cleanup,
    ctx.mod.return(ctx.mod.local.get(temp.index, temp.type)),
    ctx.mod.unreachable(),
  ];
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx, typeInstanceKey)),
    usedReturnCall: false,
  };
};

