import type {
  CodegenContext,
  FunctionMetadata,
  StaticEffectHandlerContext,
} from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import { effectsFacade } from "./facade.js";
import {
  getAbiTypesForSignature,
  getSignatureWasmType,
} from "../types.js";
import { walkHirExpression } from "../hir-walk.js";

export interface StaticEffectSpecialization {
  base: FunctionMetadata;
  meta: FunctionMetadata;
  item: HirFunction;
  context: StaticEffectHandlerContext;
}

type StaticEffectSpecializationState = {
  byKey: Map<string, StaticEffectSpecialization>;
  pending: StaticEffectSpecialization[];
  compiled: Set<string>;
};

const STATIC_EFFECT_SPECIALIZATION_STATE = Symbol(
  "voyd.effects.staticSpecializationState",
);

const stateOf = (ctx: CodegenContext): StaticEffectSpecializationState =>
  ctx.programHelpers.getHelperState<StaticEffectSpecializationState>(
    STATIC_EFFECT_SPECIALIZATION_STATE,
    () => ({
      byKey: new Map(),
      pending: [],
      compiled: new Set(),
    }),
  );

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

export const canonicalEffectOperation = (
  ctx: CodegenContext,
  symbol: number,
): ProgramSymbolId =>
  ctx.program.symbols.canonicalIdOf(ctx.moduleId, symbol) as ProgramSymbolId;

const functionItemFor = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: number;
}): HirFunction | undefined => {
  for (const item of ctx.module.hir.items.values()) {
    if (item.kind === "function" && item.symbol === symbol) {
      return item;
    }
  }
  return undefined;
};

const targetRequiresSpecialization = ({
  ctx,
  target,
}: {
  ctx: CodegenContext;
  target: ProgramSymbolId;
}): boolean => {
  const targetRef = ctx.program.symbols.refOf(target);
  const targetModule = ctx.program.modules.get(targetRef.moduleId);
  const targetInfo = targetModule?.effectsIr.info.functions.get(targetRef.symbol);
  return targetInfo?.abiEffectful === true || targetInfo?.pure === false;
};

const unresolvedCallRequiresSpecialization = ({
  ctx,
  expr,
}: {
  ctx: CodegenContext;
  expr: { exprKind: "call" | "method-call"; callee?: number };
}): boolean => {
  if (expr.exprKind !== "call" || typeof expr.callee !== "number") {
    return true;
  }
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return true;
  }
  const calleeInfo = effectsFacade(ctx).functionAbi(callee.symbol);
  return calleeInfo?.abiEffectful === true || calleeInfo?.typeEffectful === true;
};

const canSpecializeFunction = ({
  ctx,
  item,
  context,
  seen,
}: {
  ctx: CodegenContext;
  item: HirFunction;
  context: StaticEffectHandlerContext;
  seen: Set<ProgramSymbolId>;
}): boolean => {
  const canonical = canonicalEffectOperation(ctx, item.symbol);
  if (seen.has(canonical)) {
    return true;
  }
  seen.add(canonical);

  let supported = true;
  walkHirExpression({
    exprId: item.body,
    ctx,
    visitLambdaBodies: false,
    visitHandlerBodies: false,
    visitor: {
      onExpr: (exprId, expr) => {
        if (!supported) {
          return "stop";
        }
        if (
          expr.exprKind === "while" ||
          expr.exprKind === "loop" ||
          expr.exprKind === "match"
        ) {
          supported = false;
          return "stop";
        }
        if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
          return;
        }
        const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
        if (effectsFacade(ctx).callKind(exprId) === "perform") {
          const site = ctx.effectLowering.sitesByExpr.get(exprId);
          const operation =
            site?.kind === "perform"
              ? canonicalEffectOperation(ctx, site.effectSymbol)
              : undefined;
          if (typeof operation !== "number" || !context.handlers.has(operation)) {
            supported = false;
            return "stop";
          }
          return;
        }
        if (effectsFacade(ctx).callKind(exprId) !== "effectful-call") {
          return;
        }
        const targets = callInfo.targets
          ? Array.from(callInfo.targets.values())
          : [];
        if (targets.length === 0) {
          if (
            !unresolvedCallRequiresSpecialization({
              ctx,
              expr,
            })
          ) {
            return;
          }
          supported = false;
          return "stop";
        }
        const effectfulTargets = targets.filter((target) =>
          targetRequiresSpecialization({
            ctx,
            target: target as ProgramSymbolId,
          })
        );
        if (effectfulTargets.length === 0) {
          return;
        }
        for (const target of effectfulTargets) {
          const targetRef = ctx.program.symbols.refOf(target as ProgramSymbolId);
          if (targetRef.moduleId !== ctx.moduleId) {
            supported = false;
            return "stop";
          }
          const targetItem = functionItemFor({ ctx, symbol: targetRef.symbol });
          if (
            !targetItem ||
            !canSpecializeFunction({
              ctx,
              item: targetItem,
              context,
              seen,
            })
          ) {
            supported = false;
            return "stop";
          }
        }
      },
    },
  });
  return supported;
};

export const getOrCreateStaticEffectSpecialization = ({
  ctx,
  meta,
  context,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  context: StaticEffectHandlerContext;
}): FunctionMetadata | undefined => {
  const effectInfo = effectsFacade(ctx).functionAbi(meta.symbol);
  const canSpecialize = meta.effectful || effectInfo?.abiEffectful === true;
  if (!ctx.optimization || !canSpecialize || meta.moduleId !== ctx.moduleId) {
    return undefined;
  }
  const item = functionItemFor({ ctx, symbol: meta.symbol });
  if (!item) {
    return undefined;
  }
  if (
    !canSpecializeFunction({
      ctx,
      item,
      context,
      seen: new Set(),
    })
  ) {
    return undefined;
  }

  const state = stateOf(ctx);
  const key = `${meta.moduleId}:${meta.instanceId}:${context.key}`;
  const existing = state.byKey.get(key);
  if (existing) {
    return existing.meta;
  }

  const captureParamTypes = context.captures.map((capture) => capture.paramType);
  const captureTypeIds = context.captures.map((capture) => capture.typeId);
  const resultAbiTypes = getAbiTypesForSignature(meta.resultTypeId, ctx);
  const specializedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__handled_${sanitize(context.key)}`,
    paramTypes: [
      ...meta.paramAbiTypes.flat(),
      ...captureParamTypes,
    ],
    paramAbiTypes: [
      ...meta.paramAbiTypes,
      ...captureParamTypes.map((type) => [type] as const),
    ],
    userParamOffset: 0,
    firstUserParamIndex: 0,
    resultType: getSignatureWasmType(meta.resultTypeId, ctx),
    resultAbiTypes,
    paramTypeIds: [...meta.paramTypeIds, ...captureTypeIds],
    parameters: [
      ...meta.parameters,
      ...context.captures.map((capture) => ({
        typeId: capture.typeId,
        name: `__handled_${capture.symbol}`,
      })),
    ],
    paramAbiKinds: [
      ...meta.paramAbiKinds,
      ...context.captures.map(() => "direct" as const),
    ],
    resultAbiKind: "direct",
    outParamType: undefined,
    effectful: false,
    effectRow: undefined,
  };
  const specialization: StaticEffectSpecialization = {
    base: meta,
    meta: specializedMeta,
    item,
    context,
  };
  state.byKey.set(key, specialization);
  state.pending.push(specialization);
  return specializedMeta;
};

export const takePendingStaticEffectSpecializations = (
  ctx: CodegenContext,
): StaticEffectSpecialization[] => {
  const state = stateOf(ctx);
  const pending = state.pending.filter(
    (specialization) => !state.compiled.has(specialization.meta.wasmName),
  );
  state.pending = [];
  return pending;
};

export const markStaticEffectSpecializationCompiled = ({
  ctx,
  wasmName,
}: {
  ctx: CodegenContext;
  wasmName: string;
}): void => {
  stateOf(ctx).compiled.add(wasmName);
};
