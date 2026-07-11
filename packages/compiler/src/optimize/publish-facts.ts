import type { ProgramOptimizationFacts } from "./ir.js";
import type { MutableOptimizationIr } from "./state.js";

/**
 * Publishes an isolated snapshot of optimizer-owned facts. Fact producers own
 * their mutable maps; this is the single mutable-to-codegen publication seam.
 */
export const publishOptimizationFacts = (
  facts: MutableOptimizationIr["facts"],
): ProgramOptimizationFacts => {
  const snapshot = structuredClone(facts);
  return Object.freeze({
    ...snapshot,
    codegenPlan: Object.freeze({
      representations: Object.freeze({ ...facts.codegenPlan.representations }),
      specializationPolicy: facts.codegenPlan.specializationPolicy,
      specializationReservations: facts.codegenPlan.specializationReservations,
    }),
  });
};
