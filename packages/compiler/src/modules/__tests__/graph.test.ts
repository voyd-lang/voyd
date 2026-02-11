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
      [`${root}${sep}main.voyd`]: "use src::internal",
      [`${root}${sep}internal.voyd`]: "pub use self::hey::all",
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

  it("loads dependencies via bare pub module-expression exports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use src::internal",
      [`${root}${sep}internal.voyd`]: "pub self::hey::all",
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
      [`${root}${sep}server${sep}api.voyd`]: "use super::users::get_user",
      [`${root}${sep}server${sep}users${sep}get_user.voyd`]:
        "use src::server::fetch",
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

  it("anchors relative imports to the module directory", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}utils.voyd`]: "pub fn root() -> i32\n  1",
      [`${root}${sep}utils${sep}bar.voyd`]: "use super::utils",
      [`${root}${sep}utils${sep}utils.voyd`]: "pub fn nested() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}utils${sep}bar.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleKeys = Array.from(graph.modules.keys());
    expect(moduleKeys).toEqual(
      expect.arrayContaining(["src::utils::bar", "src::utils::utils"])
    );
    expect(moduleKeys).not.toEqual(expect.arrayContaining(["src::utils"]));
  });

  it("registers inline modules and resolves imports against them", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use src::internal::nested",
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

  it("discovers dependencies for grouped self-relative selections", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}grouped.voyd`]: "use self::util::{self, helpers::math}",
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
      [`${root}${sep}main.voyd`]: "use src::util::missing",
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
      [`${root}${sep}main.voyd`]: "use src::a::all\nuse src::a::src::all",
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

  it("does not implicitly add std modules when compiling a std entry module", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}map.voyd`]: "",
      [`${stdRoot}${sep}msgpack.voyd`]: "use std::map::Map",
    });

    const graph = await buildModuleGraph({
      entryPath: `${stdRoot}${sep}map.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleIds = Array.from(graph.modules.keys());
    expect(moduleIds).toEqual(expect.arrayContaining(["std::map"]));
    expect(moduleIds).not.toContain("std::pkg");
    expect(moduleIds).not.toContain("std::msgpack");
  });

  it("loads std::pkg for src modules that rely on std root re-exports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use std::{ Map }",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::map::all\npub use self::msgpack",
      [`${stdRoot}${sep}map.voyd`]: "pub obj Map {}",
      [`${stdRoot}${sep}msgpack.voyd`]: "use std::map::Map",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining(["src::main", "std::pkg", "std::msgpack", "std::map"]),
    );
  });

  it("does not load std::pkg for explicit std submodule imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use std::memory::self as memory",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::msgpack",
      [`${stdRoot}${sep}memory.voyd`]: "pub fn size() -> i32\n  0",
      [`${stdRoot}${sep}msgpack.voyd`]: "pub fn noop() -> i32\n  0",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const modules = Array.from(graph.modules.keys());
    expect(modules).toEqual(expect.arrayContaining(["src::main", "std::memory"]));
    expect(modules).not.toContain("std::pkg");
    expect(modules).not.toContain("std::msgpack");
  });

  it("resolves self-relative imports from std pkg.voyd", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use std::math::all",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::math::all",
      [`${stdRoot}${sep}math.voyd`]: "pub fn one() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining(["src::main", "std::math"]),
    );
    expect(Array.from(graph.modules.keys())).not.toContain("std::pkg");
  });

  it("treats pkg::std imports as std namespace imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use pkg::std::math::all",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use std::math::all",
      [`${stdRoot}${sep}math.voyd`]: "pub fn one() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining(["src::main", "std::math"]),
    );
    expect(Array.from(graph.modules.keys())).not.toContain("std::pkg");
  });

  it("resolves installed packages from configured pkgDirs", async () => {
    const appRoot = resolve("/proj/app");
    const pkgDir = resolve("/proj/node_modules");
    const host = createMemoryHost({
      [`${appRoot}${sep}main.voyd`]: "use pkg::my_pkg::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}pkg.voyd`]:
        "pub use src::math::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}math.voyd`]:
        "pub fn plus_one(v: i32) -> i32\n  v + 1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${appRoot}${sep}main.voyd`,
      host,
      roots: { src: appRoot, pkgDirs: [pkgDir] },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "pkg:my_pkg::pkg",
        "pkg:my_pkg::math",
      ]),
    );
  });
});
