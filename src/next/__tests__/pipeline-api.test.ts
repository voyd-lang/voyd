import { describe, expect, it } from "vitest";
import { resolve, dirname, sep } from "node:path";
import type { ModuleHost } from "../modules/types.js";
import {
  analyzeModules,
  compileProgram,
  loadModuleGraph,
  lowerProgram,
} from "../pipeline.js";

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

describe("next pipeline API", () => {
  it("compiles a program from the module graph through codegen", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm?.length ?? 0).toBeGreaterThan(0);
    expect(result.semantics?.has("src::main")).toBe(true);
  });

  it("orders modules topologically for lowering", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });
    const semantics = analyzeModules({ graph });
    const { orderedModules, entry } = lowerProgram({ graph, semantics });

    expect(entry).toBe("src::main");
    expect(orderedModules).toEqual(["src::main"]);
  });
});
