import { describe, expect, it } from "vitest";
import { dirname, resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";
import { monomorphizeProgram } from "../semantics/linking.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const registerPath = (path: string) => {
    const directParent = dirname(path);
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    const full = resolve(path);
    normalized.set(full, contents);
    registerPath(full);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    readFile: async (path: string) => {
      const resolved = resolve(path);
      const file = normalized.get(resolved);
      if (file === undefined) {
        throw new Error(`File not found: ${resolved}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolved = resolve(path);
      return Array.from(directories.get(resolved) ?? []);
    },
    fileExists: async (path: string) => normalized.has(resolve(path)),
    isDirectory: async (path: string) => isDirectoryPath(resolve(path)),
  };
};

describe("module codegen", () => {
  it("links imported functions across modules and exports only entry functions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use util::math::all

pub fn main() -> i32
  add(10, sub(5, 2))

pub fn delta() -> i32
  sub(8, 3)`,
      [`${root}${sep}util.voyd`]: "pub mod math\npub mod ops",
      [`${root}${sep}util${sep}math.voyd`]: "pub use util::ops::math::all",
      [`${root}${sep}util${sep}ops.voyd`]: "pub mod math\npub use math::all",
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

  it("links imported generic instantiations across modules", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

pub fn main() -> i32
  id(5)`,
      [`${std}${sep}util.voyd`]: `pub fn id<T>(value: T) -> T
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
