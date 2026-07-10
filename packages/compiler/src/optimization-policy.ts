export type OptimizationLevel = "none" | "balanced" | "release";

export type OptimizationPolicyInput = {
  optimizationLevel?: OptimizationLevel;
  /** Legacy switch: true maps to release and false maps to none. */
  optimize?: boolean;
  /** Legacy compiler-only profile selection used with optimize: true. */
  optimizationProfile?: "aggressive" | "standard";
};

export type ResolvedOptimizationPolicy = {
  level: OptimizationLevel;
  enabled: boolean;
  binaryenProfile?: "aggressive" | "standard";
};

/**
 * Compiler-private tunables for specializations that duplicate function bodies
 * or expand dispatch. Semantic eligibility remains in the owning pass.
 */
export type SpecializationPolicy = Readonly<{
  receiverContextsPerFunction: number;
  receiverExactParametersPerContext: number;
  directTraitSwitchImplementations: number;
  scalarAggregateLanes: number;
  scalarAggregateCallContextsPerFunction: number;
  staticEffectContextsPerFunction: number;
  callShapeContextsPerFunction: number;
  totalContextsPerFunction: number;
  totalContextsPerProgram: number;
  totalEstimatedBodyNodes: number;
}>;

const DEFAULT_SPECIALIZATION_POLICY: SpecializationPolicy = Object.freeze({
  receiverContextsPerFunction: 4,
  receiverExactParametersPerContext: 2,
  directTraitSwitchImplementations: 4,
  scalarAggregateLanes: 4,
  scalarAggregateCallContextsPerFunction: 8,
  staticEffectContextsPerFunction: 8,
  callShapeContextsPerFunction: 4,
  totalContextsPerFunction: 16,
  totalContextsPerProgram: 512,
  totalEstimatedBodyNodes: 100_000,
});

/** Public levels currently share semantic specialization limits. */
export const specializationPolicyForOptimizationLevel = (
  _level: OptimizationLevel,
): SpecializationPolicy => DEFAULT_SPECIALIZATION_POLICY;

export const resolveOptimizationPolicy = (
  input: OptimizationPolicyInput = {},
): ResolvedOptimizationPolicy => {
  if (
    input.optimizationLevel !== undefined &&
    !isOptimizationLevel(input.optimizationLevel)
  ) {
    throw new Error(
      `unknown optimization level "${String(input.optimizationLevel)}"; expected none, balanced, or release`,
    );
  }
  const level =
    input.optimizationLevel ??
    (input.optimize === true
      ? input.optimizationProfile === "standard"
        ? "balanced"
        : "release"
      : "none");

  if (level === "none") {
    return { level, enabled: false };
  }
  return {
    level,
    enabled: true,
    binaryenProfile: level === "balanced" ? "standard" : "aggressive",
  };
};

export const isOptimizationEnabled = (
  input: OptimizationPolicyInput | undefined,
): boolean => resolveOptimizationPolicy(input).enabled;

const isOptimizationLevel = (value: unknown): value is OptimizationLevel =>
  value === "none" || value === "balanced" || value === "release";
