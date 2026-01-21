import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../graph.js";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";
import { resolve, sep } from "node:path";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("buildModuleGraph", () => {
  it("loads dependencies via use statements and auto-discovers submodules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use internal",
      [`${root}${sep}internal.voyd`]: "pub mod hey",
      [`${root}${sep}internal${sep}hey.voyd`]: "pub fn hey()\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::internal",
        "src::internal::hey",
      ])
    );
  });

  it("resolves sibling modules relative to the parent module", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}server.voyd`]: "",
      [`${root}${sep}server${sep}api.voyd`]: "use users::get_user",
      [`${root}${sep}server${sep}users${sep}get_user.voyd`]:
        "use server::fetch",
      [`${root}${sep}server${sep}fetch.voyd`]: "fn fetch()\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}server.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::server",
        "src::server::api",
        "src::server::users::get_user",
        "src::server::fetch",
      ])
    );
  });

  it("registers inline modules and resolves imports against them", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use internal::nested",
      [`${root}${sep}internal.voyd`]: "mod nested\n  pub fn hi()\n    1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::internal",
        "src::internal::nested",
      ])
    );
    const inlineModule = graph.modules.get("src::internal::nested");
    expect(inlineModule?.origin.kind).toBe("inline");
    if (inlineModule?.origin.kind === "inline") {
      expect(inlineModule.origin.parentId).toBe("src::internal");
    }
  });

  it("discovers dependencies for grouped mod declarations", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}grouped.voyd`]: "mod util::{self, helpers::math}",
      [`${root}${sep}grouped${sep}util.voyd`]: "",
      [`${root}${sep}grouped${sep}util${sep}helpers${sep}math.voyd`]: "",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}grouped.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::grouped",
        "src::grouped::util",
        "src::grouped::util::helpers::math",
      ])
    );
  });

  it("emits structured diagnostics for missing modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use util::missing",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0001");
    expect(diagnostic.phase).toBe("module-graph");
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.span.file).toContain("main.voyd");
    expect(diagnostic.message).toMatch(/src::util/);
  });

  it("tracks missing modules without importer path collisions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use a::all\nuse a::src::all",
      [`${root}${sep}a.voyd`]: "use src::src::b::all",
      [`${root}${sep}a${sep}src.voyd`]: "use src::b::all",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(2);
    const messages = graph.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Unable to resolve module src::src::b",
        "Unable to resolve module src::b",
      ])
    );
  });
});
