import { describe, expect, it } from "vitest";
import type { ProgramOptimizationPass } from "../pass.js";
import { createOptimizationSchedule } from "../schedule.js";

const pass = (name: string): ProgramOptimizationPass => ({
  name,
  run: () => ({ changed: false }),
});

describe("optimizer schedule", () => {
  it("keeps structural convergence ahead of capture and escape analyses", () => {
    const schedule = createOptimizationSchedule({
      pureCompileTimeEvaluation: pass("pure"),
      booleanBranchSimplification: pass("boolean"),
      constructorKnownSimplification: pass("constructor"),
      effectFastPathElimination: pass("effect"),
      reachabilityPruning: pass("reachability"),
      exactReceiverPropagation: pass("exact"),
      traitDispatchDevirtualization: pass("devirtualization"),
      closureEnvironmentShrinking: pass("closure-captures"),
      handlerEnvironmentShrinking: pass("handler-captures"),
      runtimeTypeCheckElimination: pass("runtime-types"),
      semanticCopyForwarding: pass("copy-forwarding"),
      escapeAnalysis: pass("escape"),
      callShapeSpecialization: pass("call-shape"),
    });

    expect(schedule.initial.map(({ name }) => name)).toEqual([
      "pure",
      "boolean",
      "constructor",
      "effect",
    ]);
    expect(schedule.fixedPoint.map(({ name }) => name)).toEqual([
      "reachability",
      "exact",
      "constructor",
      "devirtualization",
      "pure",
      "boolean",
      "effect",
    ]);
    expect(schedule.final.map(({ name }) => name)).toEqual([
      "call-shape",
      "closure-captures",
      "handler-captures",
      "runtime-types",
      "copy-forwarding",
      "escape",
    ]);
    expect(schedule.minimumFixedPointIterations).toBeGreaterThan(3);
  });
});
