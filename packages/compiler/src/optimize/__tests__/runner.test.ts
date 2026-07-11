import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OptimizationAnalysisKey,
  OptimizationAnalysisResultMap,
  ProgramOptimizationContext,
  ProgramOptimizationPass,
} from "../pass.js";
import {
  runOptimizationPass,
  runOptimizationPassSequence,
  runOptimizationPassesToFixedPoint,
} from "../runner.js";

const perf = vi.hoisted(() => ({
  incrementCompilerPerfCounter: vi.fn(),
  markCompilerPerfPhaseDuration: vi.fn(),
  recordCompilerPerfDuration: vi.fn(),
  startCompilerPerfPhase: vi.fn(() => 100),
}));

vi.mock("../../perf.js", () => perf);

const createContext = ({
  events = [],
}: {
  events?: string[];
} = {}): ProgramOptimizationContext => {
  const analyses = new Map<
    OptimizationAnalysisKey,
    OptimizationAnalysisResultMap[OptimizationAnalysisKey]
  >();
  return {
    ir: {
      index: { assertStructureUnchanged: () => undefined },
    } as ProgramOptimizationContext["ir"],
    getAnalysis(key, build) {
      if (!analyses.has(key)) {
        analyses.set(key, build());
      }
      return analyses.get(key) as ReturnType<typeof build>;
    },
    mutateHirTopology(_moduleIds, mutate) {
      return mutate({} as never);
    },
    mutateCallResolution(mutate) {
      return mutate({} as never);
    },
    mutateReachability(mutate) {
      return mutate({} as never);
    },
    mutateCaptures(mutate) {
      return mutate({} as never);
    },
    mutateProducedFacts(mutate) {
      return mutate({} as never);
    },
    invalidateAnalyses(keys) {
      events.push(`invalidate:${keys.join(",")}`);
      keys.forEach((key) => analyses.delete(key));
    },
    invalidateHirBodyTopologies(moduleIds) {
      events.push(`invalidate-hir:${moduleIds.join(",")}`);
    },
  };
};

describe("optimizer pass runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves pass telemetry names and invalidates declared analyses", () => {
    const events: string[] = [];
    const context = createContext({ events });
    const pass: ProgramOptimizationPass = {
      name: "instrumented",
      run: () => ({
        changed: true,
        invalidates: ["handler-captures"],
        metrics: { matches: 2 },
      }),
    };

    expect(runOptimizationPass({ context, pass, ordinal: 7 })).toEqual({
      result: {
        changed: true,
        invalidates: ["handler-captures"],
        metrics: { matches: 2 },
      },
      nextOrdinal: 8,
    });
    expect(events).toEqual(["invalidate:handler-captures"]);
    expect(perf.markCompilerPerfPhaseDuration).toHaveBeenCalledWith(
      "optimize.pass.instrumented",
      100,
    );
    expect(perf.recordCompilerPerfDuration.mock.calls).toEqual([
      [{ name: "optimize.pass.instrumented.ms", startedAt: 100 }],
      [{ name: "optimize.pass.7.instrumented.ms", startedAt: 100 }],
    ]);
    expect(perf.incrementCompilerPerfCounter.mock.calls).toEqual([
      ["optimize.pass.instrumented.changed"],
      ["optimize.pass.7.instrumented.changed"],
      ["optimize.pass.instrumented.matches", 2],
      ["optimize.pass.7.instrumented.matches", 2],
      ["optimize.pass.instrumented.invalidates", 1],
      ["optimize.pass.7.instrumented.invalidates", 1],
    ]);
  });

  it("runs a sequence in order and invalidates before the next pass", () => {
    const events: string[] = [];
    const context = createContext({ events });
    const passes: ProgramOptimizationPass[] = [
      {
        name: "first",
        run: () => {
          events.push("run:first");
          return {
            changed: true,
            invalidates: ["reachable-function-instances"],
          };
        },
      },
      {
        name: "second",
        run: () => {
          events.push("run:second");
          return { changed: false };
        },
      },
    ];

    expect(
      runOptimizationPassSequence({ context, passes, startOrdinal: 4 }),
    ).toEqual({ changed: true, nextOrdinal: 6 });
    expect(events).toEqual([
      "run:first",
      "invalidate:reachable-function-instances",
      "run:second",
    ]);
  });

  it("forwards only the HIR modules changed by a pass", () => {
    const events: string[] = [];
    const context = createContext({ events });
    const pass: ProgramOptimizationPass = {
      name: "scoped-rewrite",
      run: () => ({
        changed: true,
        invalidates: ["hir-body-topology"],
        invalidatedHirModuleIds: ["src/main"],
      }),
    };

    runOptimizationPass({ context, pass, ordinal: 2 });

    expect(events).toEqual([
      "invalidate-hir:src/main",
      "invalidate:hir-body-topology",
    ]);
    expect(perf.incrementCompilerPerfCounter).toHaveBeenCalledWith(
      "optimize.pass.scoped-rewrite.invalidated_hir_modules",
      1,
    );
  });

  it("continues to a fixed point beyond three changing iterations", () => {
    const context = createContext();
    let calls = 0;
    const pass: ProgramOptimizationPass = {
      name: "gradual",
      run: () => {
        calls += 1;
        return { changed: calls <= 4 };
      },
    };

    expect(
      runOptimizationPassesToFixedPoint({
        context,
        passes: [pass],
        maxIterations: 6,
        startOrdinal: 10,
      }),
    ).toEqual({ changed: true, iterations: 5, nextOrdinal: 15 });
    expect(calls).toBe(5);
    expect(perf.incrementCompilerPerfCounter).toHaveBeenCalledWith(
      "optimize.fixed_point.iterations",
    );
    expect(perf.incrementCompilerPerfCounter).toHaveBeenCalledWith(
      "optimize.fixed_point.converged",
    );
  });

  it("fails loudly rather than accepting a partial result at the cap", () => {
    const context = createContext();
    const pass: ProgramOptimizationPass = {
      name: "never-stable",
      run: () => ({ changed: true }),
    };

    expect(() =>
      runOptimizationPassesToFixedPoint({
        context,
        passes: [pass],
        maxIterations: 3,
      }),
    ).toThrow("optimizer fixed-point did not converge within 3 iterations");
    expect(perf.incrementCompilerPerfCounter).toHaveBeenCalledWith(
      "optimize.fixed_point.cap_exceeded",
    );
    expect(perf.incrementCompilerPerfCounter).not.toHaveBeenCalledWith(
      "optimize.fixed_point.converged",
    );
  });

  it("rejects invalid pass metric names even when perf collection is disabled", () => {
    const context = createContext();
    const pass: ProgramOptimizationPass = {
      name: "invalid-metric",
      run: () => ({ changed: false, metrics: { "not valid": 1 } }),
    };

    expect(() => runOptimizationPass({ context, pass, ordinal: 0 })).toThrow(
      "invalid optimizer perf metric name not valid",
    );
  });
});
