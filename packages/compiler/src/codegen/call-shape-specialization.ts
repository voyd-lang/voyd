import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionMetadata,
  OptimizedValueAbiKind,
} from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";
import type { CallArgumentPlanEntry } from "../semantics/typing/types.js";
import type {
  CallShapeParameterState,
  CallShapeSpecializationRequest,
} from "../optimize/ir.js";
import {
  getOptimizedAbiTypesForParam,
  getOptimizedParamAbiKind,
  getSignatureWasmType,
} from "./types.js";
import {
  composeSpecializationDimensions,
  functionSpecializationIdentity,
  tryAdmitFunctionSpecialization,
} from "./specialization-policy.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import { walkHirExpression } from "./hir-walk.js";

export interface CallShapeSpecialization {
  base: FunctionMetadata;
  meta: FunctionMetadata;
  item: HirFunction;
}

type CallShapeSpecializationState = {
  byKey: Map<string, CallShapeSpecialization>;
  rejected: Set<string>;
  pending: CallShapeSpecialization[];
  compiled: Set<string>;
};

const CALL_SHAPE_SPECIALIZATION_STATE = Symbol(
  "voyd.codegen.callShapeSpecializationState",
);

const stateOf = (ctx: CodegenContext): CallShapeSpecializationState =>
  ctx.programHelpers.getHelperState<CallShapeSpecializationState>(
    CALL_SHAPE_SPECIALIZATION_STATE,
    () => ({
      byKey: new Map(),
      rejected: new Set(),
      pending: [],
      compiled: new Set(),
    }),
  );

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const functionItemFor = ({
  ctx,
  meta,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
}): HirFunction | undefined => {
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const targetModule =
    targetCtx?.module ?? ctx.program.modules.get(meta.moduleId);
  return Array.from(targetModule?.hir.items.values() ?? []).find(
    (item): item is HirFunction =>
      item.kind === "function" && item.symbol === meta.symbol,
  );
};

const hasEffectfulDefaultParameter = ({
  item,
  meta,
  ctx,
}: {
  item: HirFunction;
  meta: FunctionMetadata;
  ctx: CodegenContext;
}): boolean => {
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  if (!targetCtx) return false;
  return item.parameters.some((parameter) => {
    if (typeof parameter.defaultValue !== "number") return false;
    let found = false;
    walkHirExpression({
      exprId: parameter.defaultValue,
      ctx: targetCtx,
      visitLambdaBodies: false,
      visitor: {
        onExpr: (exprId) => {
          if (targetCtx.effectLowering.sitesByExpr.has(exprId)) {
            found = true;
          }
        },
      },
    });
    return found;
  });
};

export const callShapeStatesForPlan = (
  plan: readonly CallArgumentPlanEntry[],
): readonly CallShapeParameterState[] =>
  plan.map((entry) =>
    entry.kind === "omitted-default" || entry.kind === "omitted-optional"
      ? "omitted"
      : entry.kind === "stable-callsite-id"
        ? "stable-callsite-id"
        : "provided",
  );

export const callShapeKeyTokens = (
  states: readonly CallShapeParameterState[],
): readonly string[] => ["v1", ...states];

const sameTokens = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((token, index) => token === right[index]);

type SpecializedParameter = {
  typeId: number;
  abiKind: OptimizedValueAbiKind;
  abiTypes: readonly binaryen.Type[];
};

const specializedParameterFor = ({
  ctx,
  meta,
  item,
  state,
  index,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  item: HirFunction;
  state: CallShapeParameterState;
  index: number;
}): SpecializedParameter | undefined => {
  const originalTypeId = meta.paramTypeIds[index];
  const parameter = item.parameters[index];
  if (typeof originalTypeId !== "number" || !parameter) {
    return undefined;
  }
  const hasDefault = typeof parameter.defaultValue === "number";
  const bindingKind = meta.parameters[index]?.bindingKind;

  if (!hasDefault) {
    if (state === "stable-callsite-id") {
      return undefined;
    }
    if (state === "omitted") {
      const optional = ctx.program.optionals.getOptionalInfo(
        meta.moduleId,
        originalTypeId,
      );
      return optional
        ? { typeId: originalTypeId, abiKind: "direct", abiTypes: [] }
        : undefined;
    }
    return {
      typeId: originalTypeId,
      abiKind: meta.paramAbiKinds[index] ?? "direct",
      abiTypes: meta.paramAbiTypes[index] ?? [],
    };
  }

  if (state === "omitted") {
    return { typeId: originalTypeId, abiKind: "direct", abiTypes: [] };
  }
  const abiKind = getOptimizedParamAbiKind({
    typeId: originalTypeId,
    bindingKind,
    ctx,
  });
  return {
    typeId: originalTypeId,
    abiKind,
    abiTypes: getOptimizedAbiTypesForParam({
      typeId: originalTypeId,
      bindingKind,
      ctx,
    }),
  };
};

export const getOrCreateCallShapeSpecialization = ({
  ctx,
  meta,
  request,
  typedPlan,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  request: CallShapeSpecializationRequest;
  typedPlan: readonly CallArgumentPlanEntry[];
}): FunctionMetadata | undefined => {
  if (
    !ctx.optimization ||
    meta.callShape ||
    request.calleeInstanceId !== meta.instanceId
  ) {
    return undefined;
  }
  const item = functionItemFor({ ctx, meta });
  if (!item || typedPlan.length !== item.parameters.length) {
    return undefined;
  }
  if (hasEffectfulDefaultParameter({ item, meta, ctx })) {
    return undefined;
  }
  const parameterStates = callShapeStatesForPlan(typedPlan);
  const keyTokens = callShapeKeyTokens(parameterStates);
  if (!sameTokens(keyTokens, request.keyTokens)) {
    return undefined;
  }

  const specializedParameters = parameterStates.map((state, index) =>
    specializedParameterFor({ ctx, meta, item, state, index }),
  );
  if (specializedParameters.some((parameter) => !parameter)) {
    return undefined;
  }
  const parameters = specializedParameters as SpecializedParameter[];
  const specializationDimensions = composeSpecializationDimensions({
    meta,
    next: { callShape: keyTokens },
  });
  const key = functionSpecializationIdentity({
    meta,
    dimensions: specializationDimensions,
  });
  const state = stateOf(ctx);
  const existing = state.byKey.get(key);
  if (existing) {
    incrementCompilerPerfCounter("codegen.call_shape.reused_calls");
    incrementCompilerPerfCounter("codegen.call_shape.specialized_calls");
    return existing.meta;
  }
  if (state.rejected.has(key)) {
    incrementCompilerPerfCounter("codegen.call_shape.fallback_calls");
    return undefined;
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
      kind: "call_shape",
      dimensions: specializationDimensions,
      existingKindVariants: existingForFunction.length,
      maxKindVariants: ctx.specializationPolicy.callShapeContextsPerFunction,
    })
  ) {
    state.rejected.add(key);
    incrementCompilerPerfCounter("codegen.call_shape.fallback_calls");
    return undefined;
  }

  const paramAbiTypes = parameters.map((parameter) => parameter.abiTypes);
  const userParamTypes = paramAbiTypes.flat();
  const widened = ctx.effectsBackend.abi.widenSignature({
    ctx,
    effectful: meta.effectful,
    userParamTypes: meta.outParamType
      ? [meta.outParamType, ...userParamTypes]
      : userParamTypes,
    userResultType:
      meta.resultAbiKind === "out_ref"
        ? binaryen.none
        : meta.scalarAggregateResult
          ? meta.resultType
          : getSignatureWasmType(meta.resultTypeId, ctx),
  });
  const specializedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__call_shape_${sanitize(
      parameterStates
        .map((parameterState) =>
          parameterState === "provided"
            ? "p"
            : parameterState === "omitted"
              ? "o"
              : "s",
        )
        .join(""),
    )}`,
    paramTypes: widened.paramTypes,
    paramAbiTypes,
    userParamOffset: widened.userParamOffset,
    firstUserParamIndex: widened.userParamOffset + (meta.outParamType ? 1 : 0),
    resultType: widened.resultType,
    paramTypeIds: parameters.map((parameter) => parameter.typeId),
    parameters: meta.parameters.map((parameter, index) => ({
      ...parameter,
      typeId: parameters[index]!.typeId,
    })),
    paramAbiKinds: parameters.map((parameter) => parameter.abiKind),
    callShape: Object.freeze({
      keyTokens: Object.freeze([...keyTokens]),
      parameterStates: Object.freeze([...parameterStates]),
    }),
    specialization: specializationDimensions,
  };
  const specialization: CallShapeSpecialization = {
    base: meta,
    meta: specializedMeta,
    item,
  };
  state.byKey.set(key, specialization);
  state.pending.push(specialization);
  incrementCompilerPerfCounter("codegen.call_shape.specializations_created");
  incrementCompilerPerfCounter("codegen.call_shape.specialized_calls");
  incrementCompilerPerfCounter(
    "codegen.call_shape.parameters_removed",
    parameterStates.filter((parameterState) => parameterState === "omitted")
      .length,
  );
  incrementCompilerPerfCounter(
    "codegen.call_shape.default_branches_removed",
    item.parameters.filter(
      (parameter) => typeof parameter.defaultValue === "number",
    ).length,
  );
  return specializedMeta;
};

export const takePendingCallShapeSpecializations = (
  ctx: CodegenContext,
): CallShapeSpecialization[] => {
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

export const markCallShapeSpecializationCompiled = ({
  ctx,
  wasmName,
}: {
  ctx: CodegenContext;
  wasmName: string;
}): void => {
  stateOf(ctx).compiled.add(wasmName);
};
