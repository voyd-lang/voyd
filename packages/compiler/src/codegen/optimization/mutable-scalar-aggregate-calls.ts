import type { CodegenContext, FunctionMetadata } from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { MutableScalarAggregateLaneAbiFallbackReason } from "../../perf-counter-schema.js";
import { getOptimizedResultAbiKind, getStructuralTypeInfo } from "../types.js";
import {
  composeSpecializationDimensions,
  tryAdmitFunctionSpecialization,
  type FunctionSpecializationDimensions,
} from "../specialization-policy.js";

type MutableScalarAggregateLaneAbiDecision =
  | { accepted: true }
  | {
      accepted: false;
      reason: MutableScalarAggregateLaneAbiFallbackReason;
    };

export const mutableScalarAggregateCalleeCanUseLaneAbi = ({
  meta,
  paramIndex,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  ctx: CodegenContext;
}): boolean => {
  incrementCompilerPerfCounter(
    "codegen.mutable_scalar_aggregate_lane_abi.requested",
  );
  const decision = mutableScalarAggregateLaneAbiDecision({
    meta,
    paramIndex,
    ctx,
  });
  incrementCompilerPerfCounter(
    decision.accepted
      ? "codegen.mutable_scalar_aggregate_lane_abi.accepted"
      : `codegen.mutable_scalar_aggregate_lane_abi.fallback.${decision.reason}`,
  );
  return decision.accepted;
};

const mutableScalarAggregateLaneAbiDecision = ({
  meta,
  paramIndex,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  ctx: CodegenContext;
}): MutableScalarAggregateLaneAbiDecision => {
  const typeId = meta.paramTypeIds[paramIndex];
  const item = functionItemFor({ ctx, meta });
  const signature = ctx.program.functions.getSignature(
    meta.moduleId,
    meta.symbol,
  );
  const parameter = signature?.parameters[paramIndex];
  const hirParameter = item?.parameters[paramIndex];
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const structInfo =
    typeof typeId === "number" && targetCtx
      ? getStructuralTypeInfo(typeId, targetCtx)
      : undefined;
  const functionId = ctx.program.functions.getFunctionId({
    moduleId: meta.moduleId,
    symbol: meta.symbol,
  });
  const exactDecision =
    typeof functionId === "number"
      ? ctx.program.exactCallOptimizations.getFact(functionId)
      : undefined;
  const exactFact =
    exactDecision?.kind === "available" ? exactDecision.fact : undefined;
  const access = exactFact?.parameters[paramIndex];

  if (!item) return { accepted: false, reason: "missing-body" };
  if (!targetCtx) {
    return { accepted: false, reason: "missing-module-context" };
  }
  if (!structInfo || structInfo.layoutKind !== "heap-object") {
    return { accepted: false, reason: "unsupported-layout" };
  }
  if (!hirParameter || typeof hirParameter.symbol !== "number") {
    return { accepted: false, reason: "missing-parameter" };
  }
  if (!signature) return { accepted: false, reason: "missing-signature" };
  if (!ctx.program.effects.isEmpty(signature.effectRow) || meta.effectful) {
    return { accepted: false, reason: "effectful" };
  }
  if (
    meta.resultTypeId !== signature.returnType ||
    meta.resultAbiKind !== "direct" ||
    getOptimizedResultAbiKind({ typeId: meta.resultTypeId, ctx: targetCtx }) !==
      "direct"
  ) {
    return { accepted: false, reason: "result-abi" };
  }
  if (
    meta.paramAbiKinds[paramIndex] !== "mutable_ref" ||
    parameter?.bindingKind !== "mutable-ref"
  ) {
    return { accepted: false, reason: "parameter-abi" };
  }
  if (parameter.optional) {
    return { accepted: false, reason: "optional-parameter" };
  }
  if (parameter.defaulted) {
    return { accepted: false, reason: "defaulted-parameter" };
  }
  if (parameter.typeId !== typeId) {
    return { accepted: false, reason: "parameter-type" };
  }
  if (!exactFact || !access) {
    return { accepted: false, reason: "exact-fact-unavailable" };
  }
  if (
    exactFact.maySuspend ||
    exactFact.externalAccess ||
    exactFact.nestedCall ||
    exactFact.recursiveCall ||
    exactFact.dynamicCall ||
    exactFact.unresolvedCall ||
    exactFact.identityGuard
  ) {
    return { accepted: false, reason: "unsafe-boundary" };
  }
  if (
    meta.resultTypeId === ctx.program.primitives.void &&
    exactFact.explicitReturn
  ) {
    return { accepted: false, reason: "explicit-void-return" };
  }
  if (access.readsWholeValue || access.writesWholeValue) {
    return { accepted: false, reason: "whole-value-access" };
  }
  if (access.indirectAccess) {
    return { accepted: false, reason: "indirect-access" };
  }
  if (access.escapes) return { accepted: false, reason: "escape" };
  if (access.retained) return { accepted: false, reason: "retention" };
  if (access.resultAliases) {
    return { accepted: false, reason: "result-alias" };
  }
  if (access.writeFields.length === 0) {
    return { accepted: false, reason: "no-writes" };
  }
  if (
    !access.readFields.every((field) => structInfo.fieldMap.has(field)) ||
    !access.writeFields.every((field) => structInfo.fieldMap.has(field))
  ) {
    return { accepted: false, reason: "unknown-field" };
  }
  return { accepted: true };
};

export const mutableScalarAggregateSpecializationDimensions = ({
  meta,
  paramIndex,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
}): FunctionSpecializationDimensions =>
  composeSpecializationDimensions({
    meta,
    next: {
      scalarAggregate: {
        parameterIndexes: [paramIndex],
        result: false,
      },
    },
  });

export const tryReserveMutableScalarAggregateSpecialization = ({
  meta,
  paramIndex,
  existingKindVariants,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  existingKindVariants: number;
  ctx: CodegenContext;
}): boolean => {
  const item = functionItemFor({ ctx, meta });
  if (!item) {
    return false;
  }
  return tryAdmitFunctionSpecialization({
    ctx,
    meta,
    item,
    kind: "scalar_aggregate",
    dimensions: mutableScalarAggregateSpecializationDimensions({
      meta,
      paramIndex,
    }),
    existingKindVariants,
    maxKindVariants:
      ctx.specializationPolicy.scalarAggregateCallContextsPerFunction,
  });
};

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
