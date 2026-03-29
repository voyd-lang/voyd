import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const compileMain = (source: string): (() => number) => {
  const ast = parse(source, "borrowed_array_element_views.voyd");
  const moduleNode: ModuleNode = {
    id: "std::borrowed_array_element_views",
    path: { namespace: "std", segments: ["borrowed_array_element_views"] },
    origin: {
      kind: "file",
      filePath: "borrowed_array_element_views.voyd",
    },
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
  const instance = getWasmInstance(module);
  return instance.exports.main as () => number;
};

describe("borrowed array element views", () => {
  it("reads wide fields from direct fixed-array element projections", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  __array_get(arr, 0).b + __array_get(arr, 1).e
`);
    expect(main()).toBe(12);
  });

  it("keeps immutable local views borrowed across readonly field reads", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.e + value.b
`);
    expect(main()).toBe(17);
  });

  it("materializes a projected wide local before mutable-ref calls", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn bump_wide_a(~value: WideVec5)
  value.a = value.a + 10

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let value = __array_get(arr, 0)
  bump_wide_a(~value)
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(12);
  });

  it("materializes a projected wide local before returning ownership", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn copy_first(arr: FixedArray<WideVec5>) -> WideVec5
  let value = __array_get(arr, 0)
  value

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let ~copy = copy_first(arr)
  copy.a = copy.a + 10
  copy.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(12);
  });

  it("materializes a projected wide local before mutating the root container", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let value = __array_get(arr, 0)
  __array_set(arr, 0, WideVec5 { a: 9, b: 10, c: 11, d: 12, e: 13 })
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(10);
  });

  it("materializes a projected wide local before mutating through a root alias", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let alias = arr
  let value = __array_get(arr, 0)
  __array_set(alias, 0, WideVec5 { a: 9, b: 10, c: 11, d: 12, e: 13 })
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(10);
  });

  it("keeps projected wide locals borrowed across readonly root accesses", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.e + __array_len(arr)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across readonly alias accesses", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let alias = arr
  let value = __array_get(arr, 1)
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across readonly assignment aliases", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  var alias = __array_new<WideVec5>(0)
  let value = __array_get(arr, 1)
  alias = arr
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across nested readonly assignment aliases", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  var alias = __array_new<WideVec5>(0)
  let value = __array_get(arr, 1)
  if true:
    alias = arr
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("passes projected wide locals to non-mut methods without materializing eagerly", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

impl WideVec5
  fn tail_sum(self) -> i32
    self.b + self.e

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.tail_sum()
`);
    expect(main()).toBe(17);
  });

  it("passes direct projected wide receivers to non-mut methods", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

impl WideVec5
  fn tail_sum(self) -> i32
    self.b + self.e

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  __array_get(arr, 1).tail_sum()
`);
    expect(main()).toBe(17);
  });
});
