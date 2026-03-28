import type { ProgramOptimizationIR } from "./ir.js";

export type OptimizationAnalysisKey =
  | "reachable-function-instances"
  | "handler-captures"
  | "trait-dispatch-signatures";

export type ProgramOptimizationPassResult = {
  changed: boolean;
  invalidates?: readonly OptimizationAnalysisKey[];
};

export interface ProgramOptimizationContext {
  readonly ir: ProgramOptimizationIR;
  getAnalysis<T>(
    key: OptimizationAnalysisKey,
    build: () => T,
  ): T;
  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void;
}

export type ProgramOptimizationPass = {
  name: string;
  run(ctx: ProgramOptimizationContext): ProgramOptimizationPassResult;
};
