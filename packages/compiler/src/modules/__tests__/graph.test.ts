import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../graph.js";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";
import { resolve, sep } from "node:path";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("buildModuleGraph", () => {
  it("loads dependencies introduced by functional macro expansion", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::main::generated::all

macro import_helper()
  syntax_template (use src::helper::all)

macro declare_generated()
  syntax_template (mod generated
    use src::nested::all)

import_helper()
declare_generated()
`,
      [`${root}${sep}helper.voyd`]: `
macro import_deep()
  syntax_template (use src::deep::all)

import_deep()
pub fn helper()
  1
`,
      [`${root}${sep}nested.voyd`]: "pub fn nested()\n  2",
      [`${root}${sep}deep.voyd`]: "pub fn deep()\n  3",
      [`${root}${sep}main${sep}generated.voyd`]: `
use src::orphan::all
mod stale
  pub fn from_file()
    4
`,
      [`${root}${sep}orphan.voyd`]: "pub fn orphan()\n  5",
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
        "src::helper",
        "src::main::generated",
        "src::nested",
        "src::deep",
      ]),
    );
    expect(graph.modules.get("src::main::generated")?.origin.kind).toBe(
      "inline",
    );
    expect(graph.modules.has("src::main::generated::stale")).toBe(false);
    expect(graph.modules.has("src::orphan")).toBe(false);
  });

  it("validates inline modules introduced by functional macros", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
macro declare_reserved_module()
  syntax_template (mod all
    fn value()
      1)

declare_reserved_module()
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics.some((entry) => entry.code === "MD0005")).toBe(
      true,
    );
  });

  it("drops generated inline modules that disappear after re-expansion", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::b::all

macro import_c()
  syntax_template (use src::c::all)

import_c()
gen()
use self::old::all
`,
      [`${root}${sep}b.voyd`]: `
pub macro gen()
  syntax_template (mod old
    pub fn answer() -> f64
      1.0)
`,
      [`${root}${sep}c.voyd`]: `
pub macro gen()
  syntax_template (fn replacement() -> f64
    2.0)
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.modules.has("src::main::old")).toBe(false);
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MD0001" })]),
    );
  });

  it("replaces generated inline modules retained after re-expansion", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::b::all

macro import_c()
  syntax_template (use src::c::all)

import_c()
gen()
use self::child::all
`,
      [`${root}${sep}b.voyd`]: `
pub macro gen()
  syntax_template (mod child
    pub fn from_b() -> f64
      1.0)
`,
      [`${root}${sep}c.voyd`]: `
pub macro gen()
  syntax_template (mod child
    pub fn from_c() -> f64
      2.0)
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const functionNames = graph.modules
      .get("src::main::child")
      ?.surface?.items.flatMap((item) =>
        item.kind === "function"
          ? [item.declaration.signature.name.value]
          : [],
      );
    expect(functionNames).toContain("from_c");
    expect(functionNames).not.toContain("from_b");
  });

  it("prunes transient file modules and removed import diagnostics", async () => {
    const root = resolve("/proj/src");
    const badPath = `${root}${sep}bad.voyd`;
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::b::all

macro import_c()
  syntax_template (use src::c::all)

import_c()
gen()
`,
      [`${root}${sep}b.voyd`]: `
pub macro gen()
  emit_many(
    \`(use src::bad::all),
    \`(use src::missing::all)
  )
`,
      [`${root}${sep}c.voyd`]: `
pub macro gen()
  syntax_template (fn replacement() -> f64
    2.0)
`,
      [badPath]: `fn broken() -> i32
  <div class="open"
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.modules.has("src::bad")).toBe(false);
    expect(graph.diagnostics).toHaveLength(0);
  });

  it("stabilizes generated macro imports and replaces surface diagnostics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::b::all

gen()
`,
      [`${root}${sep}b.voyd`]: `
pub macro gen()
  emit_many(
    \`(use src::c::all),
    \`(mod all (block))
  )
`,
      [`${root}${sep}c.voyd`]: `
pub macro gen()
  syntax_template (fn replacement() -> f64
    2.0)
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(graph.modules.has("src::main::all")).toBe(false);
    const functionNames = graph.modules
      .get("src::main")
      ?.surface?.items.flatMap((item) =>
        item.kind === "function"
          ? [item.declaration.signature.name.value]
          : [],
      );
    expect(functionNames).toContain("replacement");
  });

  it("re-resolves package-root imports after generated inline modules disappear", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}pkg.voyd`]: `
use src::b::all
use self::macros::all

macro import_c()
  syntax_template (use src::c::all)

import_c()
gen()
declare_helper()
`,
      [`${root}${sep}b.voyd`]: `
pub macro gen()
  syntax_template (mod macros
    fn placeholder() -> f64
      1.0)
`,
      [`${root}${sep}c.voyd`]: `
pub macro gen()
  syntax_template (fn replacement() -> f64
    2.0)
`,
      [`${root}${sep}macros.voyd`]: `
pub macro declare_helper()
  syntax_template (fn helper() -> f64
    3.0)
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}pkg.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(graph.modules.has("src::pkg::macros")).toBe(false);
    const functionNames = graph.modules
      .get("src::pkg")
      ?.surface?.items.flatMap((item) =>
        item.kind === "function" ? [item.declaration.signature.name.value] : [],
      );
    expect(functionNames).toEqual(
      expect.arrayContaining(["replacement", "helper"]),
    );
  });

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

  it("treats inline modules named pkg as normal modules for self imports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
mod pkg
  use self::ops::all
  pub fn run() -> i32
    add_one(1)

  mod ops
    pub fn add_one(v: i32) -> i32
      v + 1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleKeys = Array.from(graph.modules.keys());
    expect(moduleKeys).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::main::pkg",
        "src::main::pkg::ops",
      ]),
    );
    expect(moduleKeys).not.toContain("src::main::ops");
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
    expect(diagnostic.related?.[0]?.span.file).toContain("main.voyd");
    expect(diagnostic.related?.[0]?.message).toContain("main.voyd");
  });

  it("reports parse failures as diagnostics without crashing graph construction", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [entryPath]: `fn main() -> i32\n  <div class="open"\n`,
    });

    const graph = await buildModuleGraph({
      entryPath,
      host,
      roots: { src: root },
    });

    expect(graph.modules.has("src::main")).toBe(true);
    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0002");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }

    expect(
      diagnostic.message.includes("Failed to parse"),
    ).toBe(true);
    expect(diagnostic.span.start).toBeGreaterThan(0);
    expect(diagnostic.span.end).toBe(diagnostic.span.start + 1);
  });

  it("rejects entry modules named all", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}all.voyd`]: "pub fn main() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}all.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0005");
    expect(diagnostic.message).toContain("src::all");
    expect(diagnostic.message).toContain("reserved segment 'all'");
  });

  it("rejects nested modules named all", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use src::util::all",
      [`${root}${sep}util.voyd`]: "pub fn plus_one(v: i32) -> i32\n  v + 1",
      [`${root}${sep}util${sep}all.voyd`]: "pub fn hidden() -> i32\n  0",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0005");
    expect(diagnostic.message).toContain("src::util::all");
  });

  it("rejects inline modules named all", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "mod all\n  pub fn hidden() -> i32\n    0",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0005");
    expect(diagnostic.message).toContain("src::main::all");
  });

  it("rejects nested package modules named all", async () => {
    const appRoot = resolve("/proj/app");
    const pkgDir = resolve("/proj/node_modules");
    const host = createMemoryHost({
      [`${appRoot}${sep}main.voyd`]: "use pkg::my_pkg::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}pkg.voyd`]:
        "pub use self::util::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}util.voyd`]:
        "pub fn plus_one(v: i32) -> i32\n  v + 1",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}util${sep}all.voyd`]:
        "pub fn hidden() -> i32\n  0",
    });

    const graph = await buildModuleGraph({
      entryPath: `${appRoot}${sep}main.voyd`,
      host,
      roots: { src: appRoot, pkgDirs: [pkgDir] },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0005");
    expect(diagnostic.message).toContain("pkg:my_pkg::util::all");
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
      [`${stdRoot}${sep}dict.voyd`]: "",
      [`${stdRoot}${sep}msgpack.voyd`]: "use std::dict::Dict",
    });

    const graph = await buildModuleGraph({
      entryPath: `${stdRoot}${sep}dict.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleIds = Array.from(graph.modules.keys());
    expect(moduleIds).toEqual(expect.arrayContaining(["std::dict"]));
    expect(moduleIds).not.toContain("std::pkg");
    expect(moduleIds).not.toContain("std::msgpack");
  });

  it("auto-imports std::prelude::all for src modules when std::prelude exists", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "pub fn main() -> i32\n  1",
      [`${stdRoot}${sep}prelude.voyd`]: "pub fn answer() -> i32\n  42",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining(["src::main", "std::prelude"]),
    );
  });

  it("auto-imports std::prelude::all for inline src modules when std::prelude exists", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "mod nested\n  pub fn call() -> i32\n    answer()",
      [`${stdRoot}${sep}prelude.voyd`]: "pub fn answer() -> i32\n  42",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const nested = graph.modules.get("src::main::nested");
    expect(nested).toBeDefined();
    const hasPreludeDependency = nested?.dependencies.some(
      (dependency) =>
        dependency.path.namespace === "std" &&
        dependency.path.segments.length === 1 &&
        dependency.path.segments[0] === "prelude"
    );
    expect(hasPreludeDependency).toBe(true);
  });

  it("supports #!no_prelude to suppress implicit std::prelude import", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "#!no_prelude\npub fn main() -> i32\n  1",
      [`${stdRoot}${sep}prelude.voyd`]: "pub fn answer() -> i32\n  42",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleIds = Array.from(graph.modules.keys());
    expect(moduleIds).toEqual(expect.arrayContaining(["src::main"]));
    expect(moduleIds).not.toContain("std::prelude");
  });

  it("does not auto-import std::prelude::all when std::prelude is imported explicitly", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]:
        "use std::prelude::{ answer }\npub fn main() -> i32\n  answer()",
      [`${stdRoot}${sep}prelude.voyd`]: "pub fn answer() -> i32\n  42",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleIds = Array.from(graph.modules.keys());
    expect(moduleIds).toEqual(expect.arrayContaining(["src::main", "std::prelude"]));
    expect(moduleIds).not.toContain("std::prelude::all");
  });

  it("does not crash prelude detection on incomplete use declarations", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use\npub fn main() -> i32\n  answer()",
      [`${stdRoot}${sep}prelude.voyd`]: "pub fn answer() -> i32\n  42",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    const moduleIds = Array.from(graph.modules.keys());
    expect(moduleIds).toEqual(expect.arrayContaining(["src::main", "std::prelude"]));
  });

  it("loads std::pkg for src modules that rely on std root re-exports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use std::{ Dict }",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::dict::all\npub use self::msgpack",
      [`${stdRoot}${sep}dict.voyd`]: "pub obj Dict {}",
      [`${stdRoot}${sep}msgpack.voyd`]: "use std::dict::Dict",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot, std: stdRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining(["src::main", "std::pkg", "std::msgpack", "std::dict"]),
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

  it("resolves self-relative imports from nested src pkg.voyd files", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::math::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}pkg.voyd`]:
        "pub use self::ops::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}ops.voyd`]:
        "pub fn add_one(v: i32) -> i32\n  v + 1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::pkgs::math::pkg",
        "src::pkgs::math::ops",
      ]),
    );

    const ops = graph.modules.get("src::pkgs::math::ops");
    expect(ops?.sourcePackageRoot).toEqual(["pkgs", "math"]);
    const main = graph.modules.get("src::main");
    expect(main?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: { namespace: "src", segments: ["pkgs", "math", "pkg"] },
        }),
      ]),
    );
  });

  it("resolves self-relative imports to nested pkg.voyd modules without explicit pkg segments", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::all",
      [`${srcRoot}${sep}pkgs.voyd`]: "pub use self::vtrace::draw",
      [`${srcRoot}${sep}pkgs${sep}vtrace${sep}pkg.voyd`]:
        "pub fn draw() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::pkgs",
        "src::pkgs::vtrace::pkg",
      ]),
    );
  });

  it("resolves super-relative imports from nested src pkg.voyd files", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::math::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}pkg.voyd`]:
        "pub use super::ops::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}ops.voyd`]:
        "pub fn add_one(v: i32) -> i32\n  v + 1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::pkgs::math::pkg",
        "src::pkgs::math::ops",
      ]),
    );
  });

  it("resolves super-relative imports to nested pkg.voyd modules without explicit pkg segments", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::nested::all",
      [`${srcRoot}${sep}pkgs${sep}nested.voyd`]:
        "pub use super::vtrace::draw",
      [`${srcRoot}${sep}pkgs${sep}vtrace${sep}pkg.voyd`]:
        "pub fn draw() -> i32\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::pkgs::nested",
        "src::pkgs::vtrace::pkg",
      ]),
    );
  });

  it("resolves self imports to inline modules declared inside nested pkg.voyd", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::math::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}pkg.voyd`]: `
mod outer
  pub fn one() -> i32
    1

pub use self::outer::all
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::pkgs::math::pkg",
        "src::pkgs::math::pkg::outer",
      ]),
    );
  });

  it("propagates sourcePackageRoot to deep inline descendants in nested pkg.voyd", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: "use src::pkgs::math::all",
      [`${srcRoot}${sep}pkgs${sep}math${sep}pkg.voyd`]: `
mod outer
  mod inner
    pub fn one() -> i32
      1

pub use self::outer::all
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      host,
      roots: { src: srcRoot },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const inner = graph.modules.get("src::pkgs::math::pkg::outer::inner");
    expect(inner?.sourcePackageRoot).toEqual(["pkgs", "math"]);
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

  it("infers pkg for nested installed package subpackages", async () => {
    const appRoot = resolve("/proj/app");
    const pkgDir = resolve("/proj/node_modules");
    const host = createMemoryHost({
      [`${appRoot}${sep}main.voyd`]: "use pkg::my_pkg::pkgs::math::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}pkgs${sep}math${sep}pkg.voyd`]:
        "pub use self::ops::all",
      [`${pkgDir}${sep}my_pkg${sep}src${sep}pkgs${sep}math${sep}ops.voyd`]:
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
        "pkg:my_pkg::pkgs::math::pkg",
        "pkg:my_pkg::pkgs::math::ops",
      ]),
    );
    const main = graph.modules.get("src::main");
    expect(main?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: {
            namespace: "pkg",
            packageName: "my_pkg",
            segments: ["pkgs", "math", "pkg"],
          },
        }),
      ]),
    );
  });
});
