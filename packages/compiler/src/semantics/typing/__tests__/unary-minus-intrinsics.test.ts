import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("unary minus intrinsic typing", () => {
  it("accepts numeric unary minus operands", () => {
    expect(() =>
      semanticsPipeline(loadAst("unary_minus_intrinsics_valid.voyd"))
    ).not.toThrow();
  });

  it("rejects non-numeric unary minus operands", () => {
    expect(() =>
      semanticsPipeline(loadAst("unary_minus_intrinsics_type_mismatch.voyd"))
    ).toThrow(/no overload of - matches argument types/);
  });
});
