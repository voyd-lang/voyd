import { describe, expect, it } from "vitest";
import type { ModuleGraph, ModuleNode, ModulePath } from "../../modules/types.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../pipeline.js";
import { buildProgramCodegenView } from "../codegen-view/index.js";

const buildSemantics = ({
  source,
  filePath,
  typing,
}: {
  source: string;
  filePath: string;
  typing?: { arena: any; effects: any };
}) => {
  const form = parse(source, filePath);
  const path: ModulePath = { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id: filePath,
    path,
    origin: { kind: "file", filePath },
    ast: form,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
    typing,
  });
};

describe("program function instance ids", () => {
  it("assigns deterministic ids independent of module ordering", () => {
    const moduleA = buildSemantics({
      filePath: "a.voyd",
      source: `pub fn id<T>(value: T) -> T
  value

pub fn main() -> i32
  let x = id(1)
  let y = id(1.0)
  0`,
    });

    const moduleB = buildSemantics({
      filePath: "b.voyd",
      source: `pub fn noop() -> i32
  0`,
      typing: { arena: moduleA.typing.arena, effects: moduleA.typing.effects },
    });

    const idSymbol = moduleA.symbols.resolveTopLevel("id");
    expect(typeof idSymbol).toBe("number");
    if (typeof idSymbol !== "number") return;

    const i32 = moduleA.typing.primitives.i32;
    const f64 = moduleA.typing.primitives.f64;

    const program1 = buildProgramCodegenView([moduleA, moduleB]);
    const program2 = buildProgramCodegenView([moduleB, moduleA]);

    const instanceI32_1 = program1.functions.getInstanceId(moduleA.moduleId, idSymbol, [i32]);
    const instanceF64_1 = program1.functions.getInstanceId(moduleA.moduleId, idSymbol, [f64]);
    const instanceI32_2 = program2.functions.getInstanceId(moduleA.moduleId, idSymbol, [i32]);
    const instanceF64_2 = program2.functions.getInstanceId(moduleA.moduleId, idSymbol, [f64]);

    expect(typeof instanceI32_1).toBe("number");
    expect(typeof instanceF64_1).toBe("number");
    expect(instanceI32_1).toBe(instanceI32_2);
    expect(instanceF64_1).toBe(instanceF64_2);
  });
});
