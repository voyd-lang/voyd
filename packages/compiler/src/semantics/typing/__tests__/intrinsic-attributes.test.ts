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

describe("intrinsic attributes typing", () => {
  it("rejects std-only wrappers in non-std packages", () => {
    expect(() =>
      semanticsPipeline(loadAst("intrinsic_attributes_typing.voyd"))
    ).toThrow(/TY0038: intrinsic wrapper '__array_len' is reserved for std/);
  });

  it("types intrinsic wrappers marked via attributes", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("intrinsic_attributes_typing.voyd"))
    ).not.toThrow();
  });

  it("enforces intrinsic rules for attribute-tagged raw intrinsics", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("intrinsic_attributes_len_wrong_arity.voyd"))
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });

  it("types intrinsic wrappers inside lambda bodies", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("intrinsic_attributes_lambda_typing.voyd"))
    ).not.toThrow();
  });

  it("enforces intrinsic rules inside lambda bodies", () => {
    expect(() =>
      semanticsPipeline(
        loadStdFixture("intrinsic_attributes_lambda_len_wrong_arity.voyd")
      )
    ).toThrow(/intrinsic __array_len expects 1 argument/);
  });
});
