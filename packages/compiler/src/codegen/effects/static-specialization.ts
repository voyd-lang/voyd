import type {
  CodegenContext,
  FunctionMetadata,
  StaticEffectHandlerContext,
} from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import type { CallShapeParameterState } from "../../optimize/ir.js";
import { effectsFacade } from "./facade.js";
import { getAbiTypesForSignature, getSignatureWasmType } from "../types.js";
import { walkHirExpression } from "../hir-walk.js";
import { isTraitDispatchMethodEffectful } from "../trait-dispatch-abi.js";
import {
  composeSpecializationDimensions,
  functionSpecializationIdentity,
  tryAdmitFunctionSpecialization,
} from "../specialization-policy.js";

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

type SpecializationSupport = {
  supported: boolean;
  residualEffectful: boolean;
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
  const targetInfo = targetModule?.effectsIr.info.functions.get(
    targetRef.symbol,
  );
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
  return (
    calleeInfo?.abiEffectful === true || calleeInfo?.typeEffectful === true
  );
};

const mergeSupport = (
  left: SpecializationSupport,
  right: SpecializationSupport,
): SpecializationSupport => ({
  supported: left.supported && right.supported,
  residualEffectful: left.residualEffectful || right.residualEffectful,
});

const dynamicTraitDispatchRequiresEffectfulAbi = ({
  ctx,
  targets,
}: {
  ctx: CodegenContext;
  targets: readonly ProgramSymbolId[];
}): boolean =>
  targets.some((target) => {
    const mapping = ctx.program.traits.getTraitMethodImpl(target);
    if (!mapping) {
      return true;
    }
    return isTraitDispatchMethodEffectful({
      traitSymbol: mapping.traitSymbol,
      traitMethodSymbol: mapping.traitMethodSymbol,
      ctx,
    });
  });

const analyzeSpecializationSupport = ({
  ctx,
  item,
  context,
  seen,
  callShapeParameterStates,
}: {
  ctx: CodegenContext;
  item: HirFunction;
  context: StaticEffectHandlerContext;
  seen: Set<ProgramSymbolId>;
  callShapeParameterStates?: readonly CallShapeParameterState[];
}): SpecializationSupport => {
  const canonical = canonicalEffectOperation(ctx, item.symbol);
  if (seen.has(canonical)) {
    // A recursive edge adds no effect of its own. Residual seeds discovered
    // while scanning the SCC still propagate through mergeSupport.
    return { supported: true, residualEffectful: false };
  }
  seen.add(canonical);

  let support: SpecializationSupport = {
    supported: true,
    residualEffectful: false,
  };
  const roots = [
    item.body,
    ...item.parameters.flatMap((parameter, index) =>
      typeof parameter.defaultValue === "number" &&
      (!callShapeParameterStates ||
        callShapeParameterStates[index] === "omitted")
        ? [parameter.defaultValue]
        : [],
    ),
  ];
  roots.forEach((rootExprId) => {
    if (!support.supported) {
      return;
    }
    walkHirExpression({
      exprId: rootExprId,
      ctx,
      visitLambdaBodies: false,
      visitHandlerBodies: false,
      visitor: {
        onExpr: (exprId, expr) => {
          if (!support.supported) {
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
            const handler =
              typeof operation === "number"
                ? context.handlers.get(operation)
                : undefined;
            if (handler) {
              support = {
                ...support,
                residualEffectful:
                  support.residualEffectful || handler.residualEffectful,
              };
              return;
            }
            support = { ...support, residualEffectful: true };
            return;
          }
          const targets = callInfo.targets
            ? Array.from(callInfo.targets.values()).map(
                (target) => target as ProgramSymbolId,
              )
            : [];
          if (
            callInfo.traitDispatch &&
            (targets.length === 0 ||
              dynamicTraitDispatchRequiresEffectfulAbi({
                ctx,
                targets,
              }))
          ) {
            support = { ...support, residualEffectful: true };
          }
          if (effectsFacade(ctx).callKind(exprId) !== "effectful-call") {
            return;
          }
          if (targets.length === 0) {
            if (
              !unresolvedCallRequiresSpecialization({
                ctx,
                expr,
              })
            ) {
              return;
            }
            support = { ...support, residualEffectful: true };
            return;
          }
          const effectfulTargets = targets.filter((target) =>
            targetRequiresSpecialization({
              ctx,
              target,
            }),
          );
          if (effectfulTargets.length === 0) {
            return;
          }
          for (const target of effectfulTargets) {
            const targetRef = ctx.program.symbols.refOf(
              target as ProgramSymbolId,
            );
            if (targetRef.moduleId !== ctx.moduleId) {
              support = { ...support, residualEffectful: true };
              continue;
            }
            const targetItem = functionItemFor({
              ctx,
              symbol: targetRef.symbol,
            });
            if (!targetItem) {
              support = { ...support, residualEffectful: true };
              continue;
            }
            const nested = analyzeSpecializationSupport({
              ctx,
              item: targetItem,
              context,
              seen,
            });
            support = mergeSupport(support, nested);
            if (!support.supported) {
              return "stop";
            }
          }
        },
      },
    });
  });
  return support;
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
  const support = analyzeSpecializationSupport({
    ctx,
    item,
    context,
    seen: new Set(),
    callShapeParameterStates: meta.callShape?.parameterStates,
  });
  if (!support.supported) {
    return undefined;
  }

  const state = stateOf(ctx);
  const specializationDimensions = composeSpecializationDimensions({
    meta,
    next: { staticEffect: context.key },
  });
  const key = functionSpecializationIdentity({
    meta,
    dimensions: specializationDimensions,
  });
  const existing = state.byKey.get(key);
  if (existing) {
    return existing.meta;
  }
  const existingForFunction = Array.from(state.byKey.values()).filter(
    (specialization) =>
      specialization.base.moduleId === meta.moduleId &&
      specialization.base.instanceId === meta.instanceId,
  );
  if (
    !tryAdmitFunctionSpecialization({
      ctx,
      meta,
      item,
      kind: "static_effect",
      dimensions: specializationDimensions,
      existingKindVariants: existingForFunction.length,
      maxKindVariants: ctx.specializationPolicy.staticEffectContextsPerFunction,
    })
  ) {
    return undefined;
  }

  const captureParamTypes = context.captures.map(
    (capture) => capture.paramType,
  );
  const captureTypeIds = context.captures.map((capture) => capture.typeId);
  const userParamTypes = [...meta.paramAbiTypes.flat(), ...captureParamTypes];
  const resultAbiTypes = getAbiTypesForSignature(meta.resultTypeId, ctx);
  const widened = ctx.effectsBackend.abi.widenSignature({
    ctx,
    effectful: support.residualEffectful,
    userParamTypes,
    userResultType: getSignatureWasmType(meta.resultTypeId, ctx),
  });
  const specializedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__handled_${sanitize(context.key)}`,
    paramTypes: widened.paramTypes,
    paramAbiTypes: [
      ...meta.paramAbiTypes,
      ...captureParamTypes.map((type) => [type] as const),
    ],
    userParamOffset: widened.userParamOffset,
    firstUserParamIndex: widened.userParamOffset,
    resultType: widened.resultType,
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
    effectful: support.residualEffectful,
    effectRow: support.residualEffectful ? meta.effectRow : undefined,
    specialization: specializationDimensions,
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
    (specialization) =>
      specialization.meta.moduleId === ctx.moduleId &&
      !state.compiled.has(specialization.meta.wasmName),
  );
  state.pending = state.pending.filter(
    (specialization) =>
      specialization.meta.moduleId !== ctx.moduleId &&
      !state.compiled.has(specialization.meta.wasmName),
  );
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
