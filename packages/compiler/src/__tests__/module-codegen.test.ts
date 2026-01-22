import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";
import { monomorphizeProgram } from "../semantics/linking.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("module codegen", () => {
  it("links imported functions across modules and exports only entry functions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use util::math::all

pub fn main() -> i32
  add(10, sub(5, 2))

pub fn delta() -> i32
  sub(8, 3)`,
      [`${root}${sep}util.voyd`]: "pub use self::math::all\npub use self::ops::all",
      [`${root}${sep}util${sep}math.voyd`]: "pub use ops::math::all",
      [`${root}${sep}util${sep}ops.voyd`]: "pub use self::math::all",
      [`${root}${sep}util${sep}ops${sep}math.voyd`]: `pub fn add(a: i32, b: i32) -> i32
  a + b

pub fn sub(a: i32, b: i32) -> i32
  a - b`,
    });

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
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
  api fn get(self): () -> i32
    self.value
`,
    });

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
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
      ?.functionInstantiationInfo.get(idSymbol);
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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("runs generic overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use util::assertions::all

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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("runs nominal constructor overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use animal_e2e::Animal

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

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(9);
  });
});
