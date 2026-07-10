import type {
  ProgramOptimizationContext,
  ProgramOptimizationPass,
  ProgramOptimizationPassResult,
} from "./pass.js";
import {
  emitOptimizationPassTelemetry,
  recordOptimizationFixedPointCapExceeded,
  recordOptimizationFixedPointConvergence,
  recordOptimizationFixedPointIteration,
  startOptimizationPassTelemetry,
} from "./telemetry.js";

export type OptimizationPassRunResult = {
  result: ProgramOptimizationPassResult;
  nextOrdinal: number;
};

export type OptimizationPassSequenceResult = {
  changed: boolean;
  nextOrdinal: number;
};

export type OptimizationFixedPointResult = OptimizationPassSequenceResult & {
  iterations: number;
};

export const runOptimizationPass = ({
  context,
  pass,
  ordinal,
}: {
  context: ProgramOptimizationContext;
  pass: ProgramOptimizationPass;
  ordinal: number;
}): OptimizationPassRunResult => {
  const startedAt = startOptimizationPassTelemetry();
  const result = pass.run(context);
  emitOptimizationPassTelemetry({
    passName: pass.name,
    ordinal,
    startedAt,
    result,
  });
  if (result.invalidatedHirModuleIds?.length) {
    context.invalidateHirBodyTopologies(result.invalidatedHirModuleIds);
  }
  if (result.invalidates?.length) {
    context.invalidateAnalyses(result.invalidates);
  }
  return { result, nextOrdinal: ordinal + 1 };
};

export const runOptimizationPassSequence = ({
  context,
  passes,
  startOrdinal = 0,
}: {
  context: ProgramOptimizationContext;
  passes: readonly ProgramOptimizationPass[];
  startOrdinal?: number;
}): OptimizationPassSequenceResult =>
  passes.reduce<OptimizationPassSequenceResult>(
    (sequence, pass) => {
      const passRun = runOptimizationPass({
        context,
        pass,
        ordinal: sequence.nextOrdinal,
      });
      return {
        changed: sequence.changed || passRun.result.changed,
        nextOrdinal: passRun.nextOrdinal,
      };
    },
    { changed: false, nextOrdinal: startOrdinal },
  );

export const runOptimizationPassesToFixedPoint = ({
  context,
  passes,
  maxIterations,
  startOrdinal = 0,
}: {
  context: ProgramOptimizationContext;
  passes: readonly ProgramOptimizationPass[];
  maxIterations: number;
  startOrdinal?: number;
}): OptimizationFixedPointResult => {
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error(
      "optimizer fixed-point maxIterations must be a positive integer",
    );
  }

  let iterations = 0;
  let changed = false;
  let nextOrdinal = startOrdinal;
  let lastChangingPasses: string[] = [];

  while (iterations < maxIterations) {
    let iterationChanged = false;
    const changingPasses: string[] = [];
    passes.forEach((pass) => {
      const passRun = runOptimizationPass({
        context,
        pass,
        ordinal: nextOrdinal,
      });
      nextOrdinal = passRun.nextOrdinal;
      if (!passRun.result.changed) {
        return;
      }
      iterationChanged = true;
      const nonZeroMetrics = Object.entries(passRun.result.metrics ?? {})
        .filter(([, value]) => value !== 0)
        .map(([name, value]) => `${name}=${value}`)
        .join(",");
      changingPasses.push(
        nonZeroMetrics ? `${pass.name}(${nonZeroMetrics})` : pass.name,
      );
    });
    iterations += 1;
    changed ||= iterationChanged;
    lastChangingPasses = changingPasses;
    recordOptimizationFixedPointIteration();

    if (!iterationChanged) {
      recordOptimizationFixedPointConvergence();
      return { changed, iterations, nextOrdinal };
    }
  }

  recordOptimizationFixedPointCapExceeded();
  throw new Error(
    `optimizer fixed-point did not converge within ${maxIterations} iterations; still changing: ${lastChangingPasses.join(", ")}`,
  );
};
