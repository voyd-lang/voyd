import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import {
  composeSpecializationDimensions,
  functionSpecializationIdentity,
  tryAdmitFunctionSpecialization,
} from "./specialization-policy.js";

export interface ReceiverSpecialization {
  base: FunctionMetadata;
  meta: FunctionMetadata;
  item: HirFunction;
  exactParameterTypes: ReadonlyMap<SymbolId, TypeId>;
}

type ReceiverSpecializationState = {
  byKey: Map<string, ReceiverSpecialization>;
  pending: ReceiverSpecialization[];
  compiled: Set<string>;
};

const RECEIVER_SPECIALIZATION_STATE = Symbol(
  "voyd.codegen.receiverSpecializationState",
);

const stateOf = (ctx: CodegenContext): ReceiverSpecializationState =>
  ctx.programHelpers.getHelperState<ReceiverSpecializationState>(
    RECEIVER_SPECIALIZATION_STATE,
    () => ({
      byKey: new Map(),
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

export const getOrCreateReceiverSpecialization = ({
  ctx,
  meta,
  exactParameterTypes,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exactParameterTypes: ReadonlyMap<SymbolId, TypeId>;
}): FunctionMetadata | undefined => {
  if (
    !ctx.optimization ||
    exactParameterTypes.size === 0 ||
    exactParameterTypes.size >
      ctx.specializationPolicy.receiverExactParametersPerContext
  ) {
    return undefined;
  }
  const item = functionItemFor({ ctx, meta });
  if (!item) {
    return undefined;
  }

  const combinedFacts = new Map<SymbolId, TypeId>([
    ...(ctx.optimization?.exactParameterTypes.get(meta.instanceId)?.entries() ??
      []),
    ...(meta.exactParameterTypes?.entries() ?? []),
    ...exactParameterTypes.entries(),
  ]);
  const sortedFacts = Array.from(combinedFacts.entries()).sort(
    ([left], [right]) => left - right,
  );
  if (
    sortedFacts.length >
    ctx.specializationPolicy.receiverExactParametersPerContext
  ) {
    return undefined;
  }
  const specializationDimensions = composeSpecializationDimensions({
    meta,
    next: { receiver: sortedFacts },
  });
  const key = functionSpecializationIdentity({
    meta,
    dimensions: specializationDimensions,
  });
  const state = stateOf(ctx);
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
      kind: "receiver",
      dimensions: specializationDimensions,
      existingKindVariants: existingForFunction.length,
      maxKindVariants: ctx.specializationPolicy.receiverContextsPerFunction,
    })
  ) {
    return undefined;
  }

  const specializedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__receiver_${sanitize(
      sortedFacts.map(([symbol, type]) => `${symbol}_${type}`).join("_"),
    )}`,
    exactParameterTypes: new Map(sortedFacts),
    specialization: specializationDimensions,
  };
  const specialization: ReceiverSpecialization = {
    base: meta,
    meta: specializedMeta,
    item,
    exactParameterTypes: new Map(sortedFacts),
  };
  state.byKey.set(key, specialization);
  state.pending.push(specialization);
  return specializedMeta;
};

export const takePendingReceiverSpecializations = (
  ctx: CodegenContext,
): ReceiverSpecialization[] => {
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

export const markReceiverSpecializationCompiled = ({
  ctx,
  wasmName,
}: {
  ctx: CodegenContext;
  wasmName: string;
}): void => {
  stateOf(ctx).compiled.add(wasmName);
};
