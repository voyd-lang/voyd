import type {
  OptimizationAnalysisKey,
  ProgramOptimizationContext,
} from "./pass.js";
import type { MutableOptimizationIr } from "./state.js";

/** Optimizer-private mutable context and revision invalidation boundary. */
export class MutableOptimizationContext implements ProgramOptimizationContext {
  readonly analyses = new Map<OptimizationAnalysisKey, unknown>();

  constructor(readonly ir: MutableOptimizationIr) {}

  getAnalysis<T>(key: OptimizationAnalysisKey, build: () => T): T {
    if (this.analyses.has(key)) {
      return this.analyses.get(key) as T;
    }
    const analysis = build();
    this.analyses.set(key, analysis);
    return analysis;
  }

  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void {
    keys.forEach((key) => this.analyses.delete(key));
  }

  invalidateHirBodyTopologies(moduleIds: readonly string[]): void {
    new Set(moduleIds).forEach((moduleId) =>
      this.ir.index.invalidateModuleTopology(moduleId),
    );
  }
}
