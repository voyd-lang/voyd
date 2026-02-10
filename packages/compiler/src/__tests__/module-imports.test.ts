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
      [`${root}${sep}main.voyd`]: "use src::util::math::all\npub fn main() 1",
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

  it("resolves relative module imports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}foo.voyd`]: "pub fn id() -> i32 7",
      [`${root}${sep}util${sep}bar.voyd`]:
        "use super::foo\npub fn main() -> i32\n  foo::id()",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}util${sep}bar.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const barId = "src::util::bar";
    const fooId = "src::util::foo";

    expect(graph.modules.has(barId)).toBe(true);
    expect(graph.modules.has(fooId)).toBe(true);
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("resolves std module imports without explicit self selectors", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]:
        "use std::msgpack\npub fn main() -> i32\n  msgpack::marker()",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::msgpack",
      [`${stdRoot}${sep}msgpack.voyd`]: "pub fn marker() -> i32\n  1",
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");

    expect(mainSemantics?.binding.imports.map((imp) => imp.name)).toContain(
      "msgpack",
    );
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("treats src imports as std-internal aliases when analyzing std modules", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}msgpack.voyd`]:
        "use src::msgpack::fns::marker\npub fn top() -> i32\n  marker()",
      [`${stdRoot}${sep}msgpack${sep}fns.voyd`]:
        "use std::fixed_array::fns::hidden\npub fn marker() -> i32\n  hidden()",
      [`${stdRoot}${sep}fixed_array${sep}fns.voyd`]: "pub fn hidden() -> i32\n  1",
    });

    const graph = await loadModuleGraph({
      entryPath: `${stdRoot}${sep}msgpack.voyd`,
      roots: { src: stdRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(combinedDiagnostics).toHaveLength(0);
    expect(graph.modules.has("std::msgpack::fns")).toBe(true);
    expect(graph.modules.has("src::msgpack::fns")).toBe(false);
  });
});
