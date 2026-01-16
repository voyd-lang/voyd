import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { buildProgramSymbolArena } from "../semantics/program-symbol-arena.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

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
