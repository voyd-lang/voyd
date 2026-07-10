import type { SpecializationPolicy } from "../optimization-policy.js";

export type ProgramCodegenOptimizationPlan = {
  representations: Record<string, never>;
  specializationPolicy: SpecializationPolicy;
};
