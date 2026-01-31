import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("array intrinsics typing", () => {
  it("accepts well-typed calls", () => {
    expect(() => semanticsPipeline(loadAst("array_intrinsics_valid.voyd"))).not.toThrow();
  });

  it("requires __array_new type arguments and arity", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_new_missing_type_arg.voyd"))
    ).toThrow(/intrinsic __array_new requires exactly 1 type argument/);
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_new_extra_arg.voyd"))
    ).toThrow(/intrinsic __array_new expects 1 argument\(s\)/);
  });

  it("rejects __array_get misuse", () => {
    expect(() => semanticsPipeline(loadAst("array_intrinsics_get_wrong_arity.voyd"))).toThrow(
      /intrinsic __array_get expects 2 argument\(s\)/
    );
    expect(() => semanticsPipeline(loadAst("array_intrinsics_get_type_arg.voyd"))).toThrow(
      /intrinsic __array_get does not accept type arguments/
    );
  });

  it("enforces element types for __array_set", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_set_value_type_mismatch.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("requires matching elements for positional __array_copy", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_copy_mismatch_positional.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("validates options form of __array_copy", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_copy_options_missing_field.voyd"))
    ).toThrow(/options missing field from/);
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_copy_options_type_mismatch.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("enforces __array_len arity", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_intrinsics_len_wrong_arity.voyd"))
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });
});
