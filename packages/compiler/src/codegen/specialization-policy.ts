import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import { walkHirExpression } from "./hir-walk.js";

export type FunctionSpecializationKind =
  | "receiver"
  | "scalar_aggregate"
  | "static_effect"
  | "call_shape";

export type FunctionSpecializationDimensions = Readonly<{
  receiver?: readonly (readonly [SymbolId, TypeId])[];
  scalarAggregate?: Readonly<{
    parameterIndexes: readonly number[];
    result: boolean;
  }>;
  staticEffect?: string;
  callShape?: readonly string[];
}>;

type SpecializationAdmissionState = {
  identities: Set<string>;
  identitiesByBase: Map<string, Set<string>>;
  bodyNodeEstimateByFunction: Map<string, number>;
  estimatedBodyNodes: number;
};

const SPECIALIZATION_ADMISSION_STATE = Symbol(
  "voyd.codegen.specializationAdmissionState",
);

export const composeSpecializationDimensions = ({
  meta,
  next,
}: {
  meta: FunctionMetadata;
  next: Partial<FunctionSpecializationDimensions>;
}): FunctionSpecializationDimensions => ({
  ...meta.specialization,
  ...next,
});

export const functionSpecializationIdentity = ({
  meta,
  dimensions,
}: {
  meta: FunctionMetadata;
  dimensions: FunctionSpecializationDimensions;
}): string =>
  `${meta.moduleId}:${meta.instanceId}:${JSON.stringify({
    receiver: dimensions.receiver ?? [],
    scalarAggregate: dimensions.scalarAggregate ?? null,
    staticEffect: dimensions.staticEffect ?? null,
    callShape: dimensions.callShape ?? [],
  })}`;

export const tryAdmitFunctionSpecialization = ({
  ctx,
  meta,
  item,
  kind,
  dimensions,
  existingKindVariants,
  maxKindVariants,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  item: HirFunction;
  kind: FunctionSpecializationKind;
  dimensions: FunctionSpecializationDimensions;
  existingKindVariants: number;
  maxKindVariants: number;
}): boolean => {
  const metricPrefix = `codegen.specialization.${kind}`;
  incrementCompilerPerfCounter(`${metricPrefix}.requested`);
  if (existingKindVariants >= maxKindVariants) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.kind_budget`);
    return false;
  }

  const state = stateOf(ctx);
  const identity = functionSpecializationIdentity({ meta, dimensions });
  if (state.identities.has(identity)) {
    incrementCompilerPerfCounter(`${metricPrefix}.reused`);
    return true;
  }

  const baseKey = `${meta.moduleId}:${meta.instanceId}`;
  const identitiesForBase = state.identitiesByBase.get(baseKey) ?? new Set();
  if (
    identitiesForBase.size >= ctx.specializationPolicy.totalContextsPerFunction
  ) {
    incrementCompilerPerfCounter(
      `${metricPrefix}.rejected.per_function_budget`,
    );
    return false;
  }
  if (
    state.identities.size >= ctx.specializationPolicy.totalContextsPerProgram
  ) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.program_budget`);
    return false;
  }

  const estimatedBodyNodes = estimateBodyNodes({ ctx, meta, item, state });
  if (
    state.estimatedBodyNodes + estimatedBodyNodes >
    ctx.specializationPolicy.totalEstimatedBodyNodes
  ) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.code_size_budget`);
    return false;
  }

  state.identities.add(identity);
  identitiesForBase.add(identity);
  state.identitiesByBase.set(baseKey, identitiesForBase);
  state.estimatedBodyNodes += estimatedBodyNodes;
  incrementCompilerPerfCounter(`${metricPrefix}.admitted`);
  incrementCompilerPerfCounter(
    `${metricPrefix}.estimated_body_nodes`,
    estimatedBodyNodes,
  );
  return true;
};

const stateOf = (ctx: CodegenContext): SpecializationAdmissionState =>
  ctx.programHelpers.getHelperState<SpecializationAdmissionState>(
    SPECIALIZATION_ADMISSION_STATE,
    () => ({
      identities: new Set(),
      identitiesByBase: new Map(),
      bodyNodeEstimateByFunction: new Map(),
      estimatedBodyNodes: 0,
    }),
  );

const estimateBodyNodes = ({
  ctx,
  meta,
  item,
  state,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  item: HirFunction;
  state: SpecializationAdmissionState;
}): number => {
  const key = `${meta.moduleId}:${item.body}`;
  const cached = state.bodyNodeEstimateByFunction.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const targetCtx = ctx.moduleContexts.get(meta.moduleId) ?? ctx;
  let nodes = 0;
  const seenExpressions = new Set<number>();
  const seenStatements = new Set<number>();
  const roots = [
    item.body,
    ...(item.parameters ?? []).flatMap((parameter) =>
      typeof parameter.defaultValue === "number"
        ? [parameter.defaultValue]
        : [],
    ),
  ];
  roots.forEach((exprId) =>
    walkHirExpression({
      exprId,
      ctx: targetCtx,
      visitor: {
        onExpr: (nestedExprId) => {
          if (!seenExpressions.has(nestedExprId)) {
            seenExpressions.add(nestedExprId);
            nodes += 1;
          }
        },
        onStmt: (stmtId) => {
          if (!seenStatements.has(stmtId)) {
            seenStatements.add(stmtId);
            nodes += 1;
          }
        },
      },
    }),
  );
  const estimate = Math.max(1, nodes);
  state.bodyNodeEstimateByFunction.set(key, estimate);
  return estimate;
};
