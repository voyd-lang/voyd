import type { ProgramCodegenView } from "../semantics/codegen-view/index.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { CodegenOptions } from "../codegen/context.js";
import type { ProgramOptimizationResult } from "./ir.js";
import { MutableOptimizationContext } from "./context.js";
import { finalizeOptimization } from "./finalize.js";
import {
  runOptimizationPassSequence,
  runOptimizationPassesToFixedPoint,
} from "./runner.js";
import {
  createOptimizationSchedule,
  optimizationFixedPointIterationBudget,
} from "./schedule.js";
import { recordOptimizationBodyIndexCounters } from "./telemetry.js";
import { buildOptimizationIr } from "./state.js";
import {
  pureCompileTimeEvaluationPass,
  simplifyBooleanBranchPass,
  constructorKnownSimplificationPass,
  effectFastPathEliminationPass,
} from "./passes/constant-control.js";
import { traitDispatchDevirtualizationPass } from "./passes/trait-devirtualization.js";
import {
  closureEnvironmentShrinkingPass,
  continuationAndHandlerEnvironmentShrinkingPass,
} from "./passes/capture-shrinking.js";
import { exactReceiverPropagationPass } from "./passes/receiver-propagation.js";
import {
  redundantRuntimeTypeCheckEliminationPass,
  semanticCopyForwardingPass,
} from "./passes/runtime-facts.js";
import { wholeProgramSpecializationPruningPass } from "./passes/reachability.js";
import { escapeAnalysisPass } from "./passes/escape-analysis.js";
import { callShapeSpecializationPlanningPass } from "./passes/call-shape-planning.js";

const OPTIMIZATION_SCHEDULE = createOptimizationSchedule({
  pureCompileTimeEvaluation: pureCompileTimeEvaluationPass,
  booleanBranchSimplification: simplifyBooleanBranchPass,
  constructorKnownSimplification: constructorKnownSimplificationPass,
  effectFastPathElimination: effectFastPathEliminationPass,
  reachabilityPruning: wholeProgramSpecializationPruningPass,
  exactReceiverPropagation: exactReceiverPropagationPass,
  traitDispatchDevirtualization: traitDispatchDevirtualizationPass,
  closureEnvironmentShrinking: closureEnvironmentShrinkingPass,
  handlerEnvironmentShrinking: continuationAndHandlerEnvironmentShrinkingPass,
  runtimeTypeCheckElimination: redundantRuntimeTypeCheckEliminationPass,
  semanticCopyForwarding: semanticCopyForwardingPass,
  escapeAnalysis: escapeAnalysisPass,
  callShapeSpecialization: callShapeSpecializationPlanningPass,
});

export const optimizeProgram = ({
  program,
  modules,
  entryModuleId,
  options,
}: {
  program: ProgramCodegenView;
  modules: readonly SemanticsPipelineResult[];
  entryModuleId: string;
  options?: CodegenOptions;
}): ProgramOptimizationResult => {
  const ir = buildOptimizationIr({ program, modules, entryModuleId, options });
  const context = new MutableOptimizationContext(ir);
  void entryModuleId;
  void options;

  const initial = runOptimizationPassSequence({
    context,
    passes: OPTIMIZATION_SCHEDULE.initial,
  });
  const fixedPoint = runOptimizationPassesToFixedPoint({
    context,
    passes: OPTIMIZATION_SCHEDULE.fixedPoint,
    maxIterations: optimizationFixedPointIterationBudget({
      ir,
      minimumIterations: OPTIMIZATION_SCHEDULE.minimumFixedPointIterations,
    }),
    startOrdinal: initial.nextOrdinal,
  });
  runOptimizationPassSequence({
    context,
    passes: OPTIMIZATION_SCHEDULE.final,
    startOrdinal: fixedPoint.nextOrdinal,
  });
  ir.index.assertStructureUnchanged();
  recordOptimizationBodyIndexCounters(ir.index.getBodyIndexCounters());

  return finalizeOptimization({ ir });
};
