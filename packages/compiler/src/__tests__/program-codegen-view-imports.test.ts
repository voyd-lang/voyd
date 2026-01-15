import { describe, expect, it } from "vitest";
import { dirname, resolve, sep } from "node:path";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { buildProgramCodegenView } from "../semantics/codegen-view/index.js";
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
      const resolvedPath = resolve(path);
      const file = normalized.get(resolvedPath);
      if (file === undefined) {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolvedPath = resolve(path);
      return Array.from(directories.get(resolvedPath) ?? []);
    },
    fileExists: async (path: string) => normalized.has(resolve(path)),
    isDirectory: async (path: string) => isDirectoryPath(resolve(path)),
  };
};

describe("ProgramCodegenView imports", () => {
  it("canonicalizes imported symbol ids through re-exports", async () => {
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

    const main = semantics.get("src::main");
    const math = semantics.get("src::util::math");
    expect(main).toBeDefined();
    expect(math).toBeDefined();
    if (!main || !math) return;

    const mainSymbols = getSymbolTable(main);
    const mathSymbols = getSymbolTable(math);

    const mainAdd = mainSymbols.resolve("add", mainSymbols.rootScope);
    const mathAdd = mathSymbols.resolve("add", mathSymbols.rootScope);
    expect(typeof mainAdd).toBe("number");
    expect(typeof mathAdd).toBe("number");
    if (typeof mainAdd !== "number" || typeof mathAdd !== "number") return;

    const modules = Array.from(semantics.values());
    const program = buildProgramCodegenView(modules);

    const localId = program.symbols.idOf({ moduleId: "src::main", symbol: mainAdd });
    const canonicalId = program.symbols.canonicalIdOf("src::main", mainAdd);
    const targetId = program.imports.getTarget("src::main", mainAdd);
    const declaredId = program.symbols.idOf({ moduleId: "src::util::math", symbol: mathAdd });

    expect(canonicalId).toBe(declaredId);
    expect(targetId).toBe(declaredId);
    expect(localId).not.toBe(declaredId);
  });
});

