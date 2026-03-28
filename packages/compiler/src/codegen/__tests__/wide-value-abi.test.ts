import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const compileModule = (source: string) => {
  const ast = parse(source, "wide_value_abi.voyd");
  const moduleNode: ModuleNode = {
    id: "std::wide_value_abi",
    path: { namespace: "std", segments: ["wide_value_abi"] },
    origin: {
      kind: "file",
      filePath: "wide_value_abi.voyd",
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
  const result = codegen(semantics);
  if (result.diagnostics.length > 0) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result.module;
};

describe("wide value abi", () => {
  it("allocates out-ref return storage directly", () => {
    const module = compileModule(`
pub value WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn make() -> WideVec5
  WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 }

pub fn main() -> i32
  let value = make()
  value.c
`);

    expect(module.emitText()).toContain("struct.new_default");

    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("initializes wide call results directly into local storage", () => {
    const module = compileModule(`
pub value WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn make() -> WideVec5
  WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 }

pub fn main() -> i32
  let value = make()
  value.c
`);

    const text = module.emitText();
    expect(text).toMatch(/\(if\s+\(ref\.is_null\s+\(local\.get \$0\)/);
    expect(text).toMatch(
      /\(call \$std__wide_value_abi__make_\d+\s+\(local\.get \$0\)/,
    );

    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("initializes wide mutable locals from literals without boxing a fresh value object", () => {
    const module = compileModule(`
pub value WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let ~value = WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 }
  value.c
    `);

    const text = module.emitText();
    expect(text).toMatch(/\(struct\.new_default\s/);
    expect(text).not.toMatch(/\(struct\.new\s/);

    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("writes wide literal returns into the caller-provided out-ref storage", () => {
    const module = compileModule(`
pub value WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn make() -> WideVec5
  WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 }

pub fn main() -> i32
  let ~value = make()
  value.e
`);

    const text = module.emitText();
    expect(text).toMatch(/\(call \$std__wide_value_abi__make_\d+\s+\(local\.get \$0\)/);
    expect(text).toMatch(/\(struct\.new_default\s/);
    expect(text).not.toMatch(/\(struct\.new\s/);

    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("threads storage-backed initialization through if wrappers", () => {
    const module = compileModule(`
pub value WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn make(left: i32) -> WideVec5
  WideVec5 { a: left, b: 2, c: 3, d: 4, e: 5 }

pub fn main() -> i32
  let choose_left = true
  let value = if choose_left then: make(11) else: make(22)
  value.a
`);

    const text = module.emitText();
    expect(text).toMatch(
      /\(call \$std__wide_value_abi__make_\d+\s+\(local\.get \$1\)\s+\(i32\.const 11\)/,
    );
    expect(text).toMatch(
      /\(call \$std__wide_value_abi__make_\d+\s+\(local\.get \$1\)\s+\(i32\.const 22\)/,
    );

    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(11);
  });
});
