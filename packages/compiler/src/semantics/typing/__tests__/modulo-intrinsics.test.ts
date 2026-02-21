import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("modulo intrinsic typing", () => {
  it("accepts integer modulo operands", () => {
    expect(() =>
      semanticsPipeline(loadAst("modulo_intrinsics_valid.voyd"))
    ).not.toThrow();
  });

  it("rejects non-integer modulo operands", () => {
    expect(() =>
      semanticsPipeline(loadAst("modulo_intrinsics_type_mismatch.voyd"))
    ).toThrow(/no overload of % matches argument types/);
  });
});
