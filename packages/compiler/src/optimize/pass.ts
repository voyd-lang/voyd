import type { ProgramOptimizationIR } from "./ir.js";

export type OptimizationAnalysisKey =
  | "reachable-function-instances"
  | "handler-captures"
  | "trait-dispatch-signatures"
  | "hir-body-topology";

export type ProgramOptimizationPassResult = {
  changed: boolean;
  invalidates?: readonly OptimizationAnalysisKey[];
  /** Modules whose expression topology changed during this pass. */
  invalidatedHirModuleIds?: readonly string[];
  /**
   * Stable, additive counters describing useful work performed by the pass.
   * These are emitted only when compiler perf instrumentation is enabled.
   */
  metrics?: Readonly<Record<string, number>>;
};

export interface ProgramOptimizationContext {
  readonly ir: ProgramOptimizationIR;
  getAnalysis<T>(key: OptimizationAnalysisKey, build: () => T): T;
  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void;
  invalidateHirBodyTopologies(moduleIds: readonly string[]): void;
}

export type ProgramOptimizationPass = {
  name: string;
  run(ctx: ProgramOptimizationContext): ProgramOptimizationPassResult;
};
