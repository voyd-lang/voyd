import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("intrinsic attributes typing", () => {
  it("types intrinsic wrappers marked via attributes", () => {
    expect(() =>
      semanticsPipeline(loadAst("intrinsic_attributes_typing.voyd"))
    ).not.toThrow();
  });

  it("enforces intrinsic rules for attribute-tagged raw intrinsics", () => {
    expect(() =>
      semanticsPipeline(loadAst("intrinsic_attributes_len_wrong_arity.voyd"))
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });

  it("types intrinsic wrappers inside lambda bodies", () => {
    expect(() =>
      semanticsPipeline(loadAst("intrinsic_attributes_lambda_typing.voyd"))
    ).not.toThrow();
  });

  it("enforces intrinsic rules inside lambda bodies", () => {
    expect(() =>
      semanticsPipeline(
        loadAst("intrinsic_attributes_lambda_len_wrong_arity.voyd")
      )
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });
});
