import binaryen from "binaryen";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGGRESSIVE_BINARYEN_EXTRA_PASSES,
  optimizeBinaryenModule,
} from "../binaryen-optimize.js";

describe("binaryen aggressive optimization profile", () => {
  afterEach(() => {
    delete process.env.VOYD_INTERNAL_BINARYEN_ABLATION;
    delete process.env.VOYD_BINARYEN_EXPERIMENT;
    vi.restoreAllMocks();
  });

  it("includes the heap allocation passes", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain(
      "heap-store-optimization",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("heap2local");
  });

  it("includes the broader non-default optimization set", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("const-hoisting");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("licm");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain(
      "merge-similar-functions",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("optimize-casts");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("precompute-propagate");
  });

  it("excludes high-risk non-optimization transforms", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain(
      "alignment-lowering",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain(
      "abstract-type-refining",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("asyncify");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("cfp");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("cfp-reftest");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("dfo");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gto");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gufa");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gufa-optimizing");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain(
      "inlining-optimizing",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("instrument-memory");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("jspi");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain(
      "legalize-js-interface",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("optimize-for-js");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain(
      "remove-unused-types",
    );
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("rereloop");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("reorder-types");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("remove-imports");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("signature-pruning");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("type-merging");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("type-refining");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("type-unfinalizing");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("unsubtyping");
  });

  it("can optimize a minimal module with the aggressive profile", () => {
    const mod = new binaryen.Module();
    mod.setFeatures(binaryen.Features.All);
    mod.addFunction("main", binaryen.none, binaryen.i32, [], mod.i32.const(42));
    mod.addFunctionExport("main", "main");
    const previousClosedWorld = binaryen.getClosedWorld();
    const observedClosedWorld: boolean[] = [];
    const optimize = mod.optimize.bind(mod);
    vi.spyOn(mod, "optimize").mockImplementation(() => {
      observedClosedWorld.push(binaryen.getClosedWorld());
      optimize();
    });
    binaryen.setClosedWorld(false);

    try {
      const report = optimizeBinaryenModule({
        module: mod,
        profile: "aggressive",
      });

      expect(Boolean(mod.validate())).toBe(true);
      expect(report.profile).toBe("aggressive");
      expect(report.extraPasses).toEqual(AGGRESSIVE_BINARYEN_EXTRA_PASSES);
      expect(report.phasesMs.initialOptimize).toBeGreaterThanOrEqual(0);
      expect(report.phasesMs.extraPasses).toBeGreaterThanOrEqual(0);
      expect(report.phasesMs.finalOptimize).toBeGreaterThanOrEqual(0);
      expect(observedClosedWorld).toEqual([true, true]);
      expect(binaryen.getClosedWorld()).toBe(false);
    } finally {
      binaryen.setClosedWorld(previousClosedWorld);
    }
  });

  it("uses one optimize call and no extra passes for the standard profile", () => {
    const mod = createMinimalModule();
    const optimize = vi.spyOn(mod, "optimize");
    const runPasses = vi.spyOn(mod, "runPasses");
    const previousClosedWorld = binaryen.getClosedWorld();
    binaryen.setClosedWorld(true);

    try {
      const report = optimizeBinaryenModule({
        module: mod,
        profile: "standard",
      });

      expect(optimize).toHaveBeenCalledTimes(1);
      expect(runPasses).not.toHaveBeenCalled();
      expect(report.extraPasses).toEqual([]);
      expect(Boolean(mod.validate())).toBe(true);
      expect(binaryen.getClosedWorld()).toBe(true);
    } finally {
      binaryen.setClosedWorld(previousClosedWorld);
    }
  });

  it("restores Binaryen globals when aggressive optimization throws", () => {
    const mod = createMinimalModule();
    const previousOptimizeLevel = binaryen.getOptimizeLevel();
    const previousShrinkLevel = binaryen.getShrinkLevel();
    const previousClosedWorld = binaryen.getClosedWorld();
    vi.spyOn(mod, "optimize").mockImplementation(() => {
      expect(binaryen.getClosedWorld()).toBe(true);
      throw new Error("optimization failed");
    });

    expect(() =>
      optimizeBinaryenModule({ module: mod, profile: "aggressive" }),
    ).toThrow("optimization failed");
    expect(binaryen.getOptimizeLevel()).toBe(previousOptimizeLevel);
    expect(binaryen.getShrinkLevel()).toBe(previousShrinkLevel);
    expect(binaryen.getClosedWorld()).toBe(previousClosedWorld);
  });

  it("can ablate an aggressive extra pass and the final optimize call", () => {
    enableAblation({
      disabledExtraPasses: ["heap2local"],
      skipFinalOptimize: true,
    });
    const mod = createMinimalModule();
    const optimize = vi.spyOn(mod, "optimize");
    const runPasses = vi.spyOn(mod, "runPasses");

    const report = optimizeBinaryenModule({
      module: mod,
      profile: "aggressive",
    });

    expect(optimize).toHaveBeenCalledTimes(1);
    expect(runPasses).toHaveBeenCalledTimes(1);
    expect(runPasses).toHaveBeenCalledWith(
      AGGRESSIVE_BINARYEN_EXTRA_PASSES.filter((pass) => pass !== "heap2local"),
    );
    expect(report.extraPasses).not.toContain("heap2local");
    expect(Boolean(mod.validate())).toBe(true);
  });

  it("rejects ablation for the standard profile without changing globals", () => {
    enableAblation({ disabledExtraPasses: ["heap2local"] });
    const optimizeLevel = binaryen.getOptimizeLevel();
    const shrinkLevel = binaryen.getShrinkLevel();

    expect(() =>
      optimizeBinaryenModule({
        module: createMinimalModule(),
        profile: "standard",
      }),
    ).toThrow("require the aggressive profile");
    expect(binaryen.getOptimizeLevel()).toBe(optimizeLevel);
    expect(binaryen.getShrinkLevel()).toBe(shrinkLevel);
  });

  it("ignores experiment state unless the internal guard is enabled", () => {
    process.env.VOYD_BINARYEN_EXPERIMENT = "not json";
    const report = optimizeBinaryenModule({
      module: createMinimalModule(),
      profile: "aggressive",
    });
    expect(report.extraPasses).toEqual(AGGRESSIVE_BINARYEN_EXTRA_PASSES);
  });

  it("rejects unknown guarded ablation passes", () => {
    enableAblation({ disabledExtraPasses: ["not-a-pass"] });
    expect(() =>
      optimizeBinaryenModule({
        module: createMinimalModule(),
        profile: "aggressive",
      }),
    ).toThrow("unknown Binaryen pass");
  });
});

const enableAblation = (experiment: unknown): void => {
  process.env.VOYD_INTERNAL_BINARYEN_ABLATION = "1";
  process.env.VOYD_BINARYEN_EXPERIMENT = JSON.stringify(experiment);
};

const createMinimalModule = (): binaryen.Module => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  mod.addFunction("main", binaryen.none, binaryen.i32, [], mod.i32.const(42));
  mod.addFunctionExport("main", "main");
  return mod;
};
