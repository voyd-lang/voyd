import { describe, expect, it } from "vitest";
import { dirname, resolve, sep } from "node:path";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { buildProgramSymbolArena } from "../semantics/program-symbol-arena.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";

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

describe("ProgramSymbolArena", () => {
  it("assigns deterministic ids independent of module order", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use util::all

pub fn main() -> i32
  add(1, 2)`,
      [`${root}${sep}util.voyd`]: `pub use util::math::all`,
      [`${root}${sep}util${sep}math.voyd`]: `pub fn add(a: i32, b: i32) -> i32
  a + b`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.filter((diag) => diag.severity === "error")).toHaveLength(0);

    const modules = Array.from(semantics.values());
    const arenaA = buildProgramSymbolArena(modules);
    const arenaB = buildProgramSymbolArena([...modules].reverse());

    const refs: { moduleId: string; symbol: number }[] = [];
    modules.forEach((mod) => {
      const snapshot = getSymbolTable(mod).snapshot();
      snapshot.symbols.forEach((record) => {
        if (!record) return;
        refs.push({ moduleId: mod.moduleId, symbol: record.id });
      });
    });

    const idsA = refs.map((ref) => arenaA.idOf(ref));
    const idsB = refs.map((ref) => arenaB.idOf(ref));

    expect(idsA).toEqual(idsB);

    const unique = new Set<number>(idsA);
    expect(unique.size).toBe(idsA.length);
    expect(Math.min(...idsA)).toBe(0);
    expect(Math.max(...idsA)).toBe(idsA.length - 1);
  });
});

