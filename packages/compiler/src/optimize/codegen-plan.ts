import type { SpecializationPolicy } from "../optimization-policy.js";

export type FunctionSpecializationKind =
  | "receiver"
  | "scalar_aggregate"
  | "static_effect"
  | "call_shape";

export type SpecializationBudgetReservation = Readonly<{
  contextsPerFunction: number;
  contextsPerProgram: number;
  estimatedBodyNodes: number;
}>;

export type ProgramSpecializationReservations = Readonly<
  Record<FunctionSpecializationKind, SpecializationBudgetReservation>
>;

export type ProgramCodegenOptimizationPlan = {
  representations: Record<string, never>;
  specializationPolicy: SpecializationPolicy;
  specializationReservations: ProgramSpecializationReservations;
};

const SPECIALIZATION_KINDS: readonly FunctionSpecializationKind[] = [
  "receiver",
  "scalar_aggregate",
  "static_effect",
  "call_shape",
];

/** Splits shared limits into stable per-kind reservations before codegen. */
export const createSpecializationReservations = (
  policy: SpecializationPolicy,
): ProgramSpecializationReservations => {
  const allocate = (total: number, ordinal: number): number =>
    Math.floor(total / SPECIALIZATION_KINDS.length) +
    (ordinal < total % SPECIALIZATION_KINDS.length ? 1 : 0);
  return Object.freeze(
    Object.fromEntries(
      SPECIALIZATION_KINDS.map((kind, ordinal) => [
        kind,
        Object.freeze({
          contextsPerFunction: allocate(
            policy.totalContextsPerFunction,
            ordinal,
          ),
          contextsPerProgram: allocate(policy.totalContextsPerProgram, ordinal),
          estimatedBodyNodes: allocate(policy.totalEstimatedBodyNodes, ordinal),
        }),
      ]),
    ) as Record<FunctionSpecializationKind, SpecializationBudgetReservation>,
  );
};
