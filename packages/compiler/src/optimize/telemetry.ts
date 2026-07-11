import {
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  recordCompilerPerfDuration,
  startCompilerPerfPhase,
} from "../perf.js";
import type { ProgramOptimizationPassResult } from "./pass.js";
import type { OptimizationBodyIndexCounters } from "./program-index.js";

const optimizerMetricName = (name: string): string => {
  if (!/^[a-z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid optimizer perf metric name ${name}`);
  }
  return name;
};

export const startOptimizationPassTelemetry = (): number =>
  startCompilerPerfPhase();

export const emitOptimizationPassTelemetry = ({
  passName,
  ordinal,
  startedAt,
  result,
}: {
  passName: string;
  ordinal: number;
  startedAt: number;
  result: ProgramOptimizationPassResult;
}): void => {
  markCompilerPerfPhaseDuration(`optimize.pass.${passName}`, startedAt);
  recordCompilerPerfDuration({
    name: `optimize.pass.${passName}.ms`,
    startedAt,
  });
  recordCompilerPerfDuration({
    name: `optimize.pass.${ordinal}.${passName}.ms`,
    startedAt,
  });

  if (result.changed) {
    incrementCompilerPerfCounter(`optimize.pass.${passName}.changed`);
    incrementCompilerPerfCounter(
      `optimize.pass.${ordinal}.${passName}.changed`,
    );
  }

  Object.entries(result.metrics ?? {}).forEach(([metric, value]) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `invalid optimizer perf metric value ${passName}.${metric}=${value}`,
      );
    }
    const normalizedMetric = optimizerMetricName(metric);
    incrementCompilerPerfCounter(
      `optimize.pass.${passName}.${normalizedMetric}`,
      value,
    );
    incrementCompilerPerfCounter(
      `optimize.pass.${ordinal}.${passName}.${normalizedMetric}`,
      value,
    );
  });

  if (result.invalidatedHirModuleIds?.length) {
    incrementCompilerPerfCounter(
      `optimize.pass.${passName}.invalidated_hir_modules`,
      result.invalidatedHirModuleIds.length,
    );
    incrementCompilerPerfCounter(
      `optimize.pass.${ordinal}.${passName}.invalidated_hir_modules`,
      result.invalidatedHirModuleIds.length,
    );
  }
  if (result.invalidates?.length) {
    incrementCompilerPerfCounter(
      `optimize.pass.${passName}.invalidates`,
      result.invalidates.length,
    );
    incrementCompilerPerfCounter(
      `optimize.pass.${ordinal}.${passName}.invalidates`,
      result.invalidates.length,
    );
  }
};

export const recordOptimizationFixedPointIteration = (): void => {
  incrementCompilerPerfCounter("optimize.fixed_point.iterations");
};

export const recordOptimizationFixedPointConvergence = (): void => {
  incrementCompilerPerfCounter("optimize.fixed_point.converged");
};

export const recordOptimizationFixedPointCapExceeded = (): void => {
  incrementCompilerPerfCounter("optimize.fixed_point.cap_exceeded");
};

export const recordOptimizationBodyIndexCounters = (
  counters: OptimizationBodyIndexCounters,
): void => {
  incrementCompilerPerfCounter("optimize.index.body.builds", counters.builds);
  incrementCompilerPerfCounter("optimize.index.body.hits", counters.hits);
  incrementCompilerPerfCounter("optimize.index.body.walks", counters.walks);
};
