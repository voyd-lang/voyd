import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const compileAndInstantiate = (source: string): WebAssembly.Instance => {
  const ast = parse(source, "fixed_array_structural_coercion.voyd");
  const moduleNode: ModuleNode = {
    id: "std::fixed_array_structural_coercion",
    path: { namespace: "std", segments: ["fixed_array_structural_coercion"] },
    origin: { kind: "file", filePath: "fixed_array_structural_coercion.voyd" },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleNode.id,
    modules: new Map([[moduleNode.id, moduleNode]]),
    diagnostics: [],
  };
  const semantics = semanticsPipeline({ module: moduleNode, graph });
  const { module, diagnostics } = codegen(semantics);
  if (diagnostics.length > 0) {
    throw new Error(JSON.stringify(diagnostics, null, 2));
  }
  return getWasmInstance(module);
};

describe("FixedArray structural coercions", () => {
  it("coerces FixedArray<A> into FixedArray<B> via element-by-element conversion", () => {
    const instance = compileAndInstantiate(`
type A = { x: i32, y: i32 }
type B = { x: i32 }

fn read_first_x(arr: FixedArray<B>) -> i32
  let b = __array_get(arr, 0)
  b.x

pub fn main() -> i32
  let arr = __array_new<A>(1)
  __array_set(arr, 0, { x: 7, y: 99 })
  read_first_x(arr)
`);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("coerces FixedArray<T> into FixedArray<Optional<T>> for value-object elements", () => {
    const source = `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

pub val Vec2 {
  x: i32,
  y: i32
}

fn read_first(arr: FixedArray<Optional<Vec2>>) -> i32
  let value = __array_get(arr, 0)
  match(value)
    Some<Vec2> { value: vec }:
      vec.x + vec.y
    None:
      -100

pub fn main() -> i32
  let arr = __array_new<Vec2>(1)
  __array_set(arr, 0, Vec2 { x: 7, y: 11 })
  read_first(arr)
`;
    const instance = compileAndInstantiate(source);
    expect((instance.exports.main as () => number)()).toBe(18);
  });
});
