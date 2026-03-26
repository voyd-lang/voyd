import binaryen from "binaryen";
import { describe, expect, it } from "vitest";
import {
  AGGRESSIVE_BINARYEN_EXTRA_PASSES,
  optimizeBinaryenModule,
} from "../binaryen-optimize.js";

describe("binaryen aggressive optimization profile", () => {
  it("includes the heap allocation passes", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("heap-store-optimization");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("heap2local");
  });

  it("includes the broader non-default optimization set", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("const-hoisting");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("licm");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("merge-similar-functions");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("optimize-casts");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).toContain("precompute-propagate");
  });

  it("excludes high-risk non-optimization transforms", () => {
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("alignment-lowering");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("abstract-type-refining");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("asyncify");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("cfp");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("cfp-reftest");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("dfo");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gto");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gufa");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("gufa-optimizing");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("inlining-optimizing");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("instrument-memory");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("jspi");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("legalize-js-interface");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("optimize-for-js");
    expect(AGGRESSIVE_BINARYEN_EXTRA_PASSES).not.toContain("remove-unused-types");
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
    mod.addFunction(
      "main",
      binaryen.none,
      binaryen.i32,
      [],
      mod.i32.const(42),
    );
    mod.addFunctionExport("main", "main");

    optimizeBinaryenModule({
      module: mod,
      profile: "aggressive",
    });

    expect(Boolean(mod.validate())).toBe(true);
  });
});
