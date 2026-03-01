import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { monomorphizeProgram } from "../semantics/linking.js";
import { symbolRefKey } from "../semantics/typing/symbol-ref-utils.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("module codegen", () => {
  it("links imported functions across modules and exports only entry functions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::util::math::all

pub fn main() -> i32
  add(10, sub(5, 2))

pub fn delta() -> i32
  sub(8, 3)`,
      [`${root}${sep}util.voyd`]:
        "pub use self::math::all\npub use self::ops::all",
      [`${root}${sep}util${sep}math.voyd`]: "pub use super::ops::math::all",
      [`${root}${sep}util${sep}ops.voyd`]: "pub use self::math::all",
      [`${root}${sep}util${sep}ops${sep}math.voyd`]: `pub fn add(a: i32, b: i32) -> i32
  a + b

pub fn sub(a: i32, b: i32) -> i32
  a - b`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports;
    const exportedFunctions = Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();

    expect(exportedFunctions).toEqual(["delta", "main"]);
    expect((exports.main as () => number)()).toBe(13);
    expect((exports.delta as () => number)()).toBe(5);
  });

  it("supports dot calls to imported instance methods without importing the member", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::{ Box }

pub fn main() -> i32
  Box { value: 7 }.get()
`,
      [`${std}${sep}pkg.voyd`]: "pub use std::box::{ Box }",
      [`${std}${sep}box.voyd`]: `pub obj Box {
  api value: i32
}

impl Box
  api fn get(self) -> i32
    self.value
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("runs trait dispatch for imported upcasts through package re-exports", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::all

fn consume(~seq: Sequence) -> i32
  seq.measure()

pub fn main() -> i32
  consume(~make_array(41)) + 1
`,
      [`${std}${sep}pkg.voyd`]: `pub use self::array::{ Array, make_array }
pub use self::traits::sequence::{ Sequence }
`,
      [`${std}${sep}array.voyd`]: `use std::traits::sequence::all

pub obj Array {
  value: i32
}

pub fn make_array(value: i32) -> Array
  Array { value }

impl Sequence for Array
  fn measure(~self) -> i32
    self.value
`,
      [`${std}${sep}traits${sep}sequence.voyd`]: `pub trait Sequence
  fn measure(~self) -> i32
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("links imported generic instantiations across modules", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

pub fn main() -> i32
  id(5)`,
      [`${std}${sep}pkg.voyd`]: "pub use std::util::all",
      [`${std}${sep}util.voyd`]: `pub fn id<T>(value: T): () -> T
  value`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);

    const utilSemantics = result.semantics?.get("std::util");
    expect(utilSemantics).toBeDefined();
    if (!utilSemantics) {
      return;
    }
    const idSymbol = utilSemantics.symbols.resolveTopLevel("id");
    expect(typeof idSymbol).toBe("number");
    if (typeof idSymbol !== "number") {
      return;
    }
    const monomorphized = monomorphizeProgram({
      modules: Array.from(result.semantics?.values() ?? []),
      semantics: result.semantics ?? new Map(),
    });
    const instantiations = monomorphized.moduleTyping
      .get("std::util")
      ?.functionInstantiationInfo.get(
        symbolRefKey({ moduleId: utilSemantics.moduleId, symbol: idSymbol }),
      );
    expect(instantiations?.size ?? 0).toBeGreaterThan(0);
  });

  it("links multiple imported generic instantiations across modules", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

pub fn main() -> i32
  let x = id(1.0)
  id(5)`,
      [`${std}${sep}pkg.voyd`]: "pub use std::util::all",
      [`${std}${sep}util.voyd`]: `pub fn id<T>(value: T): () -> T
  value`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("runs generic overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::util::assertions::all

pub fn main() -> i32
  let a = assert(5, eq: 5)
  let b = assert(true)
  a + b`,
      [`${root}${sep}util.voyd`]: "pub use self::assertions::all",
      [`${root}${sep}util${sep}assertions.voyd`]: `pub fn assert(cond: boolean) -> i32
  if cond then: 1 else: 0

pub fn assert<T>(value: T, { eq expected: T }) -> i32
  if value == expected then: 1 else: 0

pub fn assert<T>(value: T, { neq expected: T }) -> i32
  if value != expected then: 1 else: 0`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(2);
  });

  it("supports reassigning structural object fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  let ~o = { a: 1 }
  o.a = 3
  o.a`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("supports reassigning nested structural object fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  let ~o = { a: { b: 1 } }
  o.a.b = 3
  o.a.b`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("runs nominal constructor overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::animal_e2e::Animal

pub fn main() -> i32
  let a = Animal { name: 1 }
  let b = Animal { nombre: 2 }
  let c = Animal(3)
  a.id + b.id + c.id + a.name + b.name + c.name`,
      [`${root}${sep}animal_e2e.voyd`]: `pub obj Animal {
  id: i32,
  name: i32
}

impl Animal
  pub fn init({ name: i32 }) -> Animal
    Animal { id: 0, name }

  pub fn init({ nombre: i32 }) -> Animal
    Animal { id: 1, name: nombre }

  pub fn init(value: i32) -> Animal
    Animal { id: 2, name: value }`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(9);
  });

  it("reads module-level lets from local scope", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let base = 40
pub let addend = 2

pub fn main() -> i32
  base + addend`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("reads imported pub lets across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::constants::all

pub fn main() -> i32
  answer + 1`,
      [`${root}${sep}constants.voyd`]: `pub let answer = 41`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("supports expression initializers for module-level lets", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let a = 1

fn foo() -> i32
  7

let b = foo()
let c = if b > 4 then: 4 else: b

pub fn main() -> i32
  a + c`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });
});
