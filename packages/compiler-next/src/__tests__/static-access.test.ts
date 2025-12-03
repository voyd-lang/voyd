import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

const loadFixture = (name: string): string =>
  readFileSync(resolve(fixturesDir, name), "utf8");

const createFixtureHost = (files: Record<string, string>): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const registerPath = (path: string) => {
    const directParent = path.slice(0, path.lastIndexOf(sep));
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = current.slice(0, current.lastIndexOf(sep));
      if (!parent || parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    normalized.set(path, contents);
    registerPath(path);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    readFile: async (path: string) => {
      const file = normalized.get(path);
      if (file === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return file;
    },
    readDir: async (path: string) =>
      Array.from(directories.get(path) ?? []),
    fileExists: async (path: string) =>
      normalized.has(path) || isDirectoryPath(path),
    isDirectory: async (path: string) => isDirectoryPath(path),
  };
};

describe("static access e2e", () => {
  it("instantiates static methods using target type arguments", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("static_method_generic.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(11);
  });

  it("calls module-qualified functions without importing into scope", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const utilPath = `${root}${sep}util.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("module_access_main.voyd"),
      [utilPath]: loadFixture("module_access_util.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(41);
  });

  it("invokes static methods on imported types", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const utilPath = `${root}${sep}util.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("static_method_import_main.voyd"),
      [utilPath]: loadFixture("static_method_import_util.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(41);
  });

  it("resolves overloaded imports pulled directly into scope", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const modPath = `${root}${sep}overload_mod.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("overload_use_direct.voyd"),
      [modPath]: loadFixture("overload_mod.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("resolves overloaded module-qualified calls", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const modPath = `${root}${sep}overload_mod.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("overload_use_module.voyd"),
      [modPath]: loadFixture("overload_mod.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });
});
