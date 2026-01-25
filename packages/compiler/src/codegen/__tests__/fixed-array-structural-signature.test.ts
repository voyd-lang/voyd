import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

describe("FixedArray structural element signatures", () => {
  it("keeps element heap types concrete in signatures", () => {
    const source = `
obj Point { x: i32 }

fn read_first(arr: FixedArray<Point>) -> i32
  let p = __array_get(arr, 0)
  p.x

pub fn main() -> i32
  let arr = __array_new<Point>(1)
  __array_set(arr, 0, Point { x: 7 })
  read_first(arr)
`;
    const ast = parse(source, "fixed_array_structural_signature.voyd");
    const semantics = semanticsPipeline(ast);
    const { module, diagnostics } = codegen(semantics);
    if (diagnostics.length > 0) {
      throw new Error(JSON.stringify(diagnostics, null, 2));
    }
    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(7);
  });
});

