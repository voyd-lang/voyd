import type { ProgramOptimizationPass } from "./pass.js";
import type { ProgramOptimizationIR } from "./ir.js";

export type OptimizationPassRegistry = {
  pureCompileTimeEvaluation: ProgramOptimizationPass;
  booleanBranchSimplification: ProgramOptimizationPass;
  constructorKnownSimplification: ProgramOptimizationPass;
  effectFastPathElimination: ProgramOptimizationPass;
  reachabilityPruning: ProgramOptimizationPass;
  exactReceiverPropagation: ProgramOptimizationPass;
  traitDispatchDevirtualization: ProgramOptimizationPass;
  closureEnvironmentShrinking: ProgramOptimizationPass;
  handlerEnvironmentShrinking: ProgramOptimizationPass;
  runtimeTypeCheckElimination: ProgramOptimizationPass;
  semanticCopyForwarding: ProgramOptimizationPass;
  escapeAnalysis: ProgramOptimizationPass;
  callShapeSpecialization: ProgramOptimizationPass;
};

export type OptimizationSchedule = {
  initial: readonly ProgramOptimizationPass[];
  fixedPoint: readonly ProgramOptimizationPass[];
  final: readonly ProgramOptimizationPass[];
  minimumFixedPointIterations: number;
};

/**
 * Owns optimizer ordering separately from pass implementation. Capture and
 * escape analyses deliberately run only after structural HIR convergence.
 */
export const createOptimizationSchedule = (
  passes: OptimizationPassRegistry,
): OptimizationSchedule => ({
  initial: [
    passes.pureCompileTimeEvaluation,
    passes.booleanBranchSimplification,
    passes.constructorKnownSimplification,
    passes.effectFastPathElimination,
  ],
  fixedPoint: [
    passes.reachabilityPruning,
    passes.exactReceiverPropagation,
    passes.constructorKnownSimplification,
    passes.traitDispatchDevirtualization,
    passes.pureCompileTimeEvaluation,
    passes.booleanBranchSimplification,
    passes.effectFastPathElimination,
  ],
  final: [
    passes.callShapeSpecialization,
    passes.closureEnvironmentShrinking,
    passes.handlerEnvironmentShrinking,
    passes.runtimeTypeCheckElimination,
    passes.semanticCopyForwarding,
    passes.escapeAnalysis,
  ],
  minimumFixedPointIterations: 32,
});

/**
 * Bounds non-convergence in proportion to the number of monotone mutation
 * slots. Deep valid programs therefore get enough rounds without leaving a
 * constant-size runaway loop unchecked.
 */
export const optimizationFixedPointIterationBudget = ({
  ir,
  minimumIterations,
}: {
  ir: ProgramOptimizationIR;
  minimumIterations: number;
}): number => {
  let expressionSlots = 0;
  let callSlots = 0;
  ir.modules.forEach((moduleView) => {
    expressionSlots += moduleView.hir.expressions.size;
  });
  ir.calls.forEach((calls) => {
    callSlots += calls.size;
  });
  const parameterSlots = ir.survivingInstances.reduce((total, instance) => {
    const functionInstance = ir.baseProgram.functions.getInstance(
      instance.instanceId,
    );
    const signature = ir.baseProgram.functions.getSignature(
      functionInstance.symbolRef.moduleId,
      functionInstance.symbolRef.symbol,
    );
    return total + (signature?.parameters.length ?? 0);
  }, 0);
  const mutationSlots =
    expressionSlots * 4 +
    callSlots +
    ir.survivingInstances.length +
    parameterSlots * 2;
  return Math.max(minimumIterations, mutationSlots + 1);
};
