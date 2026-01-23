import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("boolean intrinsics typing", () => {
  it("accepts boolean logic intrinsics", () => {
    expect(() =>
      semanticsPipeline(loadAst("boolean_intrinsics_valid.voyd"))
    ).not.toThrow();
  });

  it("rejects non-boolean operands", () => {
    expect(() =>
      semanticsPipeline(loadAst("boolean_intrinsics_type_mismatch.voyd"))
    ).toThrow(/no overload of and matches argument types/);

    expect(() =>
      semanticsPipeline(loadAst("boolean_intrinsics_not_type_mismatch.voyd"))
    ).toThrow(/no overload of not matches argument types/);
  });
});
