import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import { walkHirExpression } from "./hir-walk.js";
import type { FunctionSpecializationKind } from "../optimize/codegen-plan.js";
export type { FunctionSpecializationKind } from "../optimize/codegen-plan.js";

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
  identitiesByBaseAndKind: Map<string, Set<string>>;
  identitiesByKind: Map<FunctionSpecializationKind, Set<string>>;
  bodyNodeEstimateByFunction: Map<string, number>;
  estimatedBodyNodesByKind: Map<FunctionSpecializationKind, number>;
};

export type SpecializationAdmissionDecision =
  | Readonly<{ stage: "admission"; outcome: "admitted" | "reused" }>
  | Readonly<{
      stage: "admission";
      outcome: "rejected";
      reason:
        | "kind_budget"
        | "per_function_budget"
        | "program_budget"
        | "code_size_budget";
    }>;

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

export const decideFunctionSpecializationAdmission = ({
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
}): SpecializationAdmissionDecision => {
  const metricPrefix = `codegen.specialization.${kind}`;
  incrementCompilerPerfCounter(`${metricPrefix}.requested`);
  if (existingKindVariants >= maxKindVariants) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.kind_budget`);
    return { stage: "admission", outcome: "rejected", reason: "kind_budget" };
  }

  const state = stateOf(ctx);
  const identity = functionSpecializationIdentity({ meta, dimensions });
  if (state.identities.has(identity)) {
    incrementCompilerPerfCounter(`${metricPrefix}.reused`);
    return { stage: "admission", outcome: "reused" };
  }

  const reservation = ctx.specializationReservations[kind];
  const baseAndKindKey = `${meta.moduleId}:${meta.instanceId}:${kind}`;
  const identitiesForBaseAndKind =
    state.identitiesByBaseAndKind.get(baseAndKindKey) ?? new Set();
  if (identitiesForBaseAndKind.size >= reservation.contextsPerFunction) {
    incrementCompilerPerfCounter(
      `${metricPrefix}.rejected.per_function_budget`,
    );
    return {
      stage: "admission",
      outcome: "rejected",
      reason: "per_function_budget",
    };
  }
  const identitiesForKind = state.identitiesByKind.get(kind) ?? new Set();
  if (identitiesForKind.size >= reservation.contextsPerProgram) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.program_budget`);
    return {
      stage: "admission",
      outcome: "rejected",
      reason: "program_budget",
    };
  }

  const estimatedBodyNodes = estimateBodyNodes({ ctx, meta, item, state });
  if (
    (state.estimatedBodyNodesByKind.get(kind) ?? 0) + estimatedBodyNodes >
    reservation.estimatedBodyNodes
  ) {
    incrementCompilerPerfCounter(`${metricPrefix}.rejected.code_size_budget`);
    return {
      stage: "admission",
      outcome: "rejected",
      reason: "code_size_budget",
    };
  }

  state.identities.add(identity);
  identitiesForBaseAndKind.add(identity);
  state.identitiesByBaseAndKind.set(baseAndKindKey, identitiesForBaseAndKind);
  identitiesForKind.add(identity);
  state.identitiesByKind.set(kind, identitiesForKind);
  state.estimatedBodyNodesByKind.set(
    kind,
    (state.estimatedBodyNodesByKind.get(kind) ?? 0) + estimatedBodyNodes,
  );
  incrementCompilerPerfCounter(`${metricPrefix}.admitted`);
  incrementCompilerPerfCounter(
    `${metricPrefix}.estimated_body_nodes`,
    estimatedBodyNodes,
  );
  return { stage: "admission", outcome: "admitted" };
};

export const tryAdmitFunctionSpecialization = (
  args: Parameters<typeof decideFunctionSpecializationAdmission>[0],
): boolean =>
  decideFunctionSpecializationAdmission(args).outcome !== "rejected";

const stateOf = (ctx: CodegenContext): SpecializationAdmissionState =>
  ctx.programHelpers.getHelperState<SpecializationAdmissionState>(
    SPECIALIZATION_ADMISSION_STATE,
    () => ({
      identities: new Set(),
      identitiesByBaseAndKind: new Map(),
      identitiesByKind: new Map(),
      bodyNodeEstimateByFunction: new Map(),
      estimatedBodyNodesByKind: new Map(),
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
