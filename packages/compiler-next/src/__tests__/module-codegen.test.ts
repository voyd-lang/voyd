import { describe, expect, it } from "vitest";
import { dirname, resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";

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
      [`${root}${sep}util${sep}math.voyd`]:
        "pub use util::ops::math::all",
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

    expect(result.diagnostics).toHaveLength(0);
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

  it("supports reassigning structural object fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  let &o = { a: 1 }
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
  let &o = { a: { b: 1 } }
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
});
