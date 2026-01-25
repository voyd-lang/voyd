import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

describe("FixedArray structural coercions", () => {
  it("coerces FixedArray<A> into FixedArray<B> via element-by-element conversion", () => {
    const source = `
type A = { x: i32, y: i32 }
type B = { x: i32 }

fn read_first_x(arr: FixedArray<B>) -> i32
  let b = __array_get(arr, 0)
  b.x

pub fn main() -> i32
  let arr = __array_new<A>(1)
  __array_set(arr, 0, { x: 7, y: 99 })
  read_first_x(arr)
`;
    const ast = parse(source, "fixed_array_structural_coercion.voyd");
    const semantics = semanticsPipeline(ast);
    const { module, diagnostics } = codegen(semantics);
    if (diagnostics.length > 0) {
      throw new Error(JSON.stringify(diagnostics, null, 2));
    }
    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(7);
  });
});

