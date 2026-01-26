import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

describe("Union coercion target selection", () => {
  it("prefers exact member matches over structural supertypes", () => {
    const source = `
type A = { x: i32 }
type B = { x: i32, y: i32 }
type U = A | B

fn pick_y(u: U) -> i32
  match(u)
    B: u.y
    A: -1

pub fn main() -> i32
  let b: B = { x: 1, y: 41 }
  pick_y(b)
`;
    const ast = parse(source, "union_coercion_target.voyd");
    const semantics = semanticsPipeline(ast);
    const { module, diagnostics } = codegen(semantics);
    if (diagnostics.length > 0) {
      throw new Error(JSON.stringify(diagnostics, null, 2));
    }
    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(41);
  });
});

