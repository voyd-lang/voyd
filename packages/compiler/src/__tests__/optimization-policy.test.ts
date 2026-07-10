import { describe, expect, it } from "vitest";
import {
  resolveOptimizationPolicy,
  specializationPolicyForOptimizationLevel,
  type OptimizationLevel,
} from "../optimization-policy.js";

describe("compiler optimization policy", () => {
  it("defaults to an unoptimized build", () => {
    expect(resolveOptimizationPolicy()).toEqual({
      level: "none",
      enabled: false,
    });
  });

  it("maps public levels to stable Binaryen profiles", () => {
    expect(
      resolveOptimizationPolicy({ optimizationLevel: "balanced" }),
    ).toEqual({
      level: "balanced",
      enabled: true,
      binaryenProfile: "standard",
    });
    expect(resolveOptimizationPolicy({ optimizationLevel: "release" })).toEqual(
      {
        level: "release",
        enabled: true,
        binaryenProfile: "aggressive",
      },
    );
  });

  it("keeps optimize boolean compatibility", () => {
    expect(resolveOptimizationPolicy({ optimize: false }).level).toBe("none");
    expect(resolveOptimizationPolicy({ optimize: true }).level).toBe("release");
    expect(
      resolveOptimizationPolicy({
        optimize: true,
        optimizationProfile: "standard",
      }).level,
    ).toBe("balanced");
  });

  it("gives the explicit level precedence over legacy options", () => {
    expect(
      resolveOptimizationPolicy({
        optimizationLevel: "balanced",
        optimize: false,
        optimizationProfile: "aggressive",
      }),
    ).toEqual({
      level: "balanced",
      enabled: true,
      binaryenProfile: "standard",
    });
  });

  it("rejects invalid runtime level values", () => {
    expect(() =>
      resolveOptimizationPolicy({
        optimizationLevel: "balance" as OptimizationLevel,
      }),
    ).toThrow('unknown optimization level "balance"');
  });

  it("centralizes finite private specialization limits for every level", () => {
    const balanced = specializationPolicyForOptimizationLevel("balanced");
    const release = specializationPolicyForOptimizationLevel("release");

    expect(balanced).toBe(release);
    expect(Object.isFrozen(balanced)).toBe(true);
    Object.values(balanced).forEach((limit) => {
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    });
    expect(balanced.receiverContextsPerFunction).toBe(4);
    expect(balanced.receiverExactParametersPerContext).toBe(2);
    expect(balanced.directTraitSwitchImplementations).toBe(4);
  });
});
