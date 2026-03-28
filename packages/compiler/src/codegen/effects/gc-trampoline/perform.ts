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
} from "../../locals.js";
import { coerceValueToType, lowerValueForHeapField } from "../../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  wasmHeapFieldTypeFor,
} from "../../types.js";
import { handlerCleanupOps } from "../handler-stack.js";
import { captureContinuationEnvFieldValue } from "./shared.js";
import {
  continuationFunctionName,
  ensureContinuationFunction,
} from "./continuations.js";
import { specializeContinuationSite } from "./specialize-site.js";
import { getEffectOpInstanceInfo, resolvePerformSignature } from "../effect-registry.js";
import { ensureEffectArgsType } from "../args-type.js";
import { ensureEffectsMemory } from "../host-boundary/imports.js";
import { LINEAR_MEMORY_INTERNAL } from "../host-boundary/constants.js";
import { ensureEffectHandleTable } from "../handle-table.js";
import { tailResumptionExitChecks } from "../tail-resumptions.js";

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
  const siteTemplate = ctx.effectLowering.sitesByExpr.get(expr.id);
  if (!siteTemplate || siteTemplate.kind !== "perform") {
    throw new Error("codegen missing effect lowering info for perform site");
  }
  const signature = ctx.program.functions.getSignature(ctx.moduleId, calleeSymbol);
  if (!signature) {
    throw new Error("codegen missing effect operation signature");
  }
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const site = specializeContinuationSite({
    site: siteTemplate,
    ctx,
    typeInstanceId,
  });
  if (site.kind !== "perform") {
    throw new Error("codegen missing effect lowering info for perform site");
  }
  const registry = ctx.effectsState.effectRegistry;
  if (!registry) {
    throw new Error("codegen missing effect registry");
  }
  const opInfo = getEffectOpInstanceInfo({
    ctx,
    site,
    typeInstanceId,
    registry,
  });
  const args = expr.args.map((arg, index) => {
    const expectedTypeId = signature.parameters[index]?.typeId;
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });

  const envValues = site.envFields.map((field) =>
    captureContinuationEnvFieldValue({
      field,
      siteOrder: site.siteOrder,
      ctx,
      fnCtx,
    })
  );

  const contRefType = ensureContinuationFunction({
    site,
    ctx,
    typeInstanceId,
  });
  const contFnName = continuationFunctionName({ site, typeInstanceId });
  const env = initStruct(ctx.mod, site.envType, envValues as number[]);
  const contRef = refFunc(ctx.mod, contFnName, contRefType);
  const continuation = ctx.effectsRuntime.makeContinuation({
    fnRef: contRef,
    env,
    site: ctx.mod.i32.const(site.siteOrder),
  });
  const signatureTypes = resolvePerformSignature({
    site,
    ctx,
    typeInstanceId,
  });
  const argsType = ensureEffectArgsType({
    ctx,
    opIndex: opInfo.opIndex,
    paramTypes: signatureTypes.params,
  });
  const argsBoxed = argsType
    ? initStruct(
        ctx.mod,
        argsType,
        args.map((arg, index) => {
          const typeId = signatureTypes.params[index]!;
          const storageType = wasmHeapFieldTypeFor(typeId, ctx, new Set(), "runtime");
          return storageType === binaryen.getExpressionType(arg)
            ? arg
            : lowerValueForHeapField({
                value: arg,
                typeId,
                targetType: storageType,
                ctx,
                fnCtx,
              });
        }) as number[],
      )
    : ctx.mod.ref.null(binaryen.eqref);
  ensureEffectsMemory(ctx);
  const handleTable = ensureEffectHandleTable(ctx);
  const handlePtr = ctx.mod.i32.add(
    ctx.mod.global.get(handleTable.tableBaseGlobal, binaryen.i32),
    ctx.mod.i32.const(opInfo.opIndex * 4)
  );
  const handleValue = ctx.mod.i32.load(0, 4, handlePtr, LINEAR_MEMORY_INTERNAL);
  const request = ctx.effectsRuntime.makeEffectRequest({
    effectId: ctx.mod.i64.const(
      opInfo.effectId.hash.low,
      opInfo.effectId.hash.high
    ),
    opId: ctx.mod.i32.const(opInfo.opId),
    opIndex: ctx.mod.i32.const(opInfo.opIndex),
    resumeKind: ctx.mod.i32.const(opInfo.resumeKind),
    handle: handleValue,
    args: argsBoxed,
    continuation,
    tailGuard: ctx.effectsRuntime.makeTailGuard(),
  });

  const exprRef = ctx.mod.block(
    null,
    [ctx.effectsRuntime.makeOutcomeEffect(request)],
    ctx.effectsRuntime.outcomeType
  );

  if (!fnCtx.effectful) {
    return { expr: exprRef, usedReturnCall: false };
  }

  const cleanup = handlerCleanupOps({ ctx, fnCtx });
  const tailChecks = tailResumptionExitChecks({ ctx, fnCtx });
  const temp = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(temp.index, exprRef),
    ...tailChecks,
    ...cleanup,
    ctx.mod.return(ctx.mod.local.get(temp.index, temp.type)),
    ctx.mod.unreachable(),
  ];
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx, typeInstanceId)),
    usedReturnCall: false,
  };
};
