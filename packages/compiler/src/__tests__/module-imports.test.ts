import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("module imports", () => {
  it("binds imports across modules using the module graph exports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use util::math::all\npub fn main() 1",
      [`${root}${sep}util${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const mathSemantics = semantics.get("src::util::math");

    expect(mainSemantics?.binding.imports.map((imp) => imp.name)).toContain(
      "add"
    );
    expect(mathSemantics?.exports.has("add")).toBe(true);
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });
});
