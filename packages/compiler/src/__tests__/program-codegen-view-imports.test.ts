import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { buildProgramCodegenView } from "../semantics/codegen-view/index.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

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
