import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExprId,
  TypeId,
} from "../../context.js";
import { coerceValueToType } from "../../structural.js";
import { allocateTempLocal } from "../../locals.js";
import {
  getRequiredExprType,
  wasmTypeFor,
} from "../../types.js";
import { resolveTempCaptureTypeId } from "../../effects/temp-capture-types.js";

export const handlerType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsBackend.abi.hiddenHandlerParamType(ctx);

export const hiddenParamOffsetFor = (meta: FunctionMetadata): number =>
  meta.effectful
    ? Math.max(0, meta.paramTypes.length - meta.paramTypeIds.length)
    : 0;

export const debugEffects = (): boolean =>
  typeof process !== "undefined" && process.env?.DEBUG_EFFECTS === "1";

export const currentHandlerValue = (
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (fnCtx.currentHandler) {
    return ctx.mod.local.get(
      fnCtx.currentHandler.index,
      fnCtx.currentHandler.type
    );
  }
  return ctx.effectsBackend.abi.hiddenHandlerValue(ctx);
};

const activeSiteInSet = ({
  sites,
  activeSiteOrder,
  ctx,
}: {
  sites: ReadonlySet<number>;
  activeSiteOrder: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (sites.size === 0) return ctx.mod.i32.const(0);

  const comparisons = [...sites].map((siteOrder) =>
    ctx.mod.i32.eq(activeSiteOrder(), ctx.mod.i32.const(siteOrder))
  );
  return comparisons.reduce(
    (acc, cmp) => ctx.mod.i32.or(acc, cmp),
    ctx.mod.i32.const(0)
  );
};

const getOrCreateTempLocal = ({
  tempId,
  ctx,
  fnCtx,
}: {
  tempId: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { index: number; type: binaryen.Type } => {
  const existing = fnCtx.tempLocals.get(tempId);
  if (existing) return existing;

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId =
    typeof typeInstanceId === "number"
      ? resolveTempCaptureTypeId({
          tempId,
          ctx,
          typeInstanceId,
        })
      : (ctx.effectLowering.tempTypeIds.get(tempId) ??
        ctx.program.primitives.unknown);

  const wasmType = wasmTypeFor(typeId, ctx);
  const local = allocateTempLocal(wasmType, fnCtx, typeId);
  fnCtx.tempLocals.set(tempId, local);
  return local;
};

export const compileCallArgExpressionsWithTemps = ({
  callId,
  args,
  argIndexOffset,
  allArgExprIds,
  expectedTypeIdAt,
  ctx,
  fnCtx,
  compileExpr,
}: {
  callId: HirExprId;
  args: readonly { expr: HirExprId }[];
  argIndexOffset?: number;
  allArgExprIds?: readonly HirExprId[];
  expectedTypeIdAt: (index: number) => TypeId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const offset = argIndexOffset ?? 0;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const tempSpecs = ctx.effectLowering.callArgTemps.get(callId) ?? [];
  const tempsByIndex = new Map(
    tempSpecs.map((entry) => [entry.argIndex, entry.tempId] as const)
  );

  const continuationCfg = fnCtx.continuation?.cfg;
  const startedLocal = fnCtx.continuation?.startedLocal;
  const activeSiteLocal = fnCtx.continuation?.activeSiteLocal;
  const sourceArgExprIds = allArgExprIds ?? args.map((arg) => arg.expr);

  const laterSites =
    continuationCfg && startedLocal && activeSiteLocal
      ? args.map((_, index) => {
          const globalIndex = index + offset;
          const sites = new Set<number>();
          for (
            let nextIndex = globalIndex + 1;
            nextIndex < sourceArgExprIds.length;
            nextIndex += 1
          ) {
            (continuationCfg.sitesByExpr.get(sourceArgExprIds[nextIndex]!) ?? []).forEach(
              (site) => sites.add(site)
            );
          }
          return sites;
        })
      : undefined;

  return args.map((arg, index) => {
    const expectedTypeId = expectedTypeIdAt(index);
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
    const tempId = tempsByIndex.get(index + offset);

    if (typeof tempId !== "number") {
      const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
      return coerceValueToType({
        value: value.expr,
        actualType: actualTypeId,
        targetType: expectedTypeId,
        ctx,
        fnCtx,
      });
    }

    const tempLocal = getOrCreateTempLocal({ tempId, ctx, fnCtx });
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    const coerced = coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });

    const compute = ctx.mod.block(
      null,
      [
        ctx.mod.local.set(tempLocal.index, coerced),
        ctx.mod.local.get(tempLocal.index, tempLocal.type),
      ],
      tempLocal.type
    );

    if (!laterSites || !startedLocal || !activeSiteLocal) {
      return compute;
    }

    const shouldSkip = ctx.mod.i32.and(
      ctx.mod.i32.eqz(ctx.mod.local.get(startedLocal.index, binaryen.i32)),
      activeSiteInSet({
        sites: laterSites[index] ?? new Set<number>(),
        activeSiteOrder: () =>
          ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
        ctx,
      })
    );

    return ctx.mod.if(
      shouldSkip,
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
      compute
    );
  });
};

export const compileCallCalleeExpressionWithTemp = ({
  call,
  ctx,
  fnCtx,
  compileExpr,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const calleeValue = compileExpr({ exprId: call.callee, ctx, fnCtx });
  const calleeTemp = (ctx.effectLowering.callArgTemps.get(call.id) ?? []).find(
    (entry) => entry.argIndex === -1
  );

  if (!calleeTemp) {
    return calleeValue;
  }

  const tempLocal = getOrCreateTempLocal({
    tempId: calleeTemp.tempId,
    ctx,
    fnCtx,
  });

  const compute = ctx.mod.block(
    null,
    [
      ctx.mod.local.set(tempLocal.index, calleeValue.expr),
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
    ],
    tempLocal.type
  );

  const continuationCfg = fnCtx.continuation?.cfg;
  const startedLocal = fnCtx.continuation?.startedLocal;
  const activeSiteLocal = fnCtx.continuation?.activeSiteLocal;
  if (!continuationCfg || !startedLocal || !activeSiteLocal) {
    return { expr: compute, usedReturnCall: false };
  }

  const laterSites = call.args.reduce((sites, arg) => {
    (continuationCfg.sitesByExpr.get(arg.expr) ?? []).forEach((site) =>
      sites.add(site)
    );
    return sites;
  }, new Set<number>());
  if (laterSites.size === 0) {
    return { expr: compute, usedReturnCall: false };
  }

  const shouldSkip = ctx.mod.i32.and(
    ctx.mod.i32.eqz(ctx.mod.local.get(startedLocal.index, binaryen.i32)),
    activeSiteInSet({
      sites: laterSites,
      activeSiteOrder: () =>
        ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
      ctx,
    })
  );

  return {
    expr: ctx.mod.if(
      shouldSkip,
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
      compute
    ),
    usedReturnCall: false,
  };
};
