import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { ModuleGraph, ModuleNode } from "../../../modules/types.js";

const loadStdFixture = (fixtureName: string): { module: ModuleNode; graph: ModuleGraph } => {
  const ast = loadAst(fixtureName);
  const name = fixtureName.replace(/\.voyd$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
  const module: ModuleNode = {
    id: `std::${name}`,
    path: { namespace: "std", segments: [name] },
    origin: { kind: "file", filePath: fixtureName },
    ast,
    source: "",
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return { module, graph };
};

describe("array intrinsics typing", () => {
  it("rejects raw intrinsic calls in non-std packages", () => {
    expect(() => semanticsPipeline(loadAst("array_intrinsics_valid.voyd"))).toThrow(
      /TY0006: function '__array_new' is not defined/
    );
  });

  it("accepts well-typed calls", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_valid.voyd"))
    ).not.toThrow();
  });

  it("requires __array_new type arguments and arity", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_new_missing_type_arg.voyd"))
    ).toThrow(/intrinsic __array_new requires exactly 1 type argument/);
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_new_extra_arg.voyd"))
    ).toThrow(/intrinsic __array_new expects 1 argument\(s\)/);
  });

  it("rejects __array_get misuse", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_get_wrong_arity.voyd"))
    ).toThrow(/intrinsic __array_get expects 2 argument\(s\)/);
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_get_type_arg.voyd"))
    ).toThrow(/intrinsic __array_get does not accept type arguments/);
  });

  it("enforces element types for __array_set", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_set_value_type_mismatch.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("requires matching elements for positional __array_copy", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_copy_mismatch_positional.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("validates options form of __array_copy", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_copy_options_missing_field.voyd"))
    ).toThrow(/options missing field from/);
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_copy_options_type_mismatch.voyd"))
    ).toThrow(/TY0027: type mismatch: expected 'i32', received 'bool'/);
  });

  it("enforces __array_len arity", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("array_intrinsics_len_wrong_arity.voyd"))
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });
});
