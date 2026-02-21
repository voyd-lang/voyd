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

describe("float intrinsic typing", () => {
  it("accepts unary float intrinsics in std modules", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("float_intrinsics_valid.voyd"))
    ).not.toThrow();
  });

  it("rejects non-float operands", () => {
    expect(() =>
      semanticsPipeline(loadStdFixture("float_intrinsics_type_mismatch.voyd"))
    ).toThrow(/no overload of __pow matches argument types/);
  });
});
