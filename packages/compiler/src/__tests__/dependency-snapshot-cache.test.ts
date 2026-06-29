import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "../modules/types.js";
import {
  commitDependencySnapshot,
  createCompilerDependencySnapshotCache,
  prepareDependencySnapshotReuse,
} from "../modules/dependency-snapshot-cache.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const loadAndAnalyze = async ({
  files,
  roots,
  cache,
}: {
  files: Record<string, string>;
  roots: ModuleRoots;
  cache: ReturnType<typeof createCompilerDependencySnapshotCache>;
}) => {
  const host = createMemoryHost(files);
  const graph = await loadModuleGraph({
    entryPath: `${roots.src}${sep}main.voyd`,
    roots,
    host,
  });
  const prepared = prepareDependencySnapshotReuse({
    cache,
    graph,
    roots,
  });
  const analyzed = analyzeModules({
    graph,
    captureDependencySnapshot: Boolean(prepared.key),
    previousSemantics: prepared.previousSemantics,
    typingState: prepared.typingState,
  });
  const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];
  expect(diagnostics).toHaveLength(0);
  commitDependencySnapshot({
    prepared,
    dependencySnapshot: analyzed.dependencySnapshot,
  });
  return { prepared, analyzed };
};

const buildFiles = ({
  appValue,
  stdValue,
  pkgValue,
}: {
  appValue: number;
  stdValue: number;
  pkgValue: number;
}) => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const pkgRoot = resolve("/proj/packages");
  return {
    roots: { src: srcRoot, std: stdRoot, pkgDirs: [pkgRoot] },
    files: {
      [`${srcRoot}${sep}main.voyd`]: [
        "#!no_prelude",
        "use std::mathdep::{ std_value }",
        "use pkg::dep::all",
        "",
        "pub fn main() -> i32",
        `  std_value() + pkg_value() + ${appValue}`,
      ].join("\n"),
      [`${stdRoot}${sep}mathdep.voyd`]: [
        "#!no_prelude",
        "pub fn std_value() -> i32",
        `  ${stdValue}`,
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}pkg.voyd`]: [
        "#!no_prelude",
        "pub use src::api::pkg_value",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}api.voyd`]: [
        "#!no_prelude",
        "pub fn pkg_value() -> i32",
        `  ${pkgValue}`,
      ].join("\n"),
    },
  };
};

describe("compiler dependency snapshots", () => {
  it("does not capture dependency semantics unless requested", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const host = createMemoryHost(initial.files);
    const graph = await loadModuleGraph({
      entryPath: `${initial.roots.src}${sep}main.voyd`,
      roots: initial.roots,
      host,
    });

    const analyzed = analyzeModules({ graph });

    expect(analyzed.dependencySnapshot).toBeUndefined();
  });

  it("reuses std and installed package semantics after a source edit", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const first = await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache,
    });
    expect(first.prepared.hit).toBe(false);

    const edited = buildFiles({ appValue: 2, stdValue: 10, pkgValue: 100 });
    const second = await loadAndAnalyze({
      files: edited.files,
      roots: edited.roots,
      cache,
    });

    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
  });

  it("invalidates the dependency snapshot when std source changes", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({ files: initial.files, roots: initial.roots, cache });

    const editedStd = buildFiles({ appValue: 1, stdValue: 11, pkgValue: 100 });
    const result = await loadAndAnalyze({
      files: editedStd.files,
      roots: editedStd.roots,
      cache,
    });

    expect(result.prepared.hit).toBe(false);
    expect(result.analyzed.recomputedModuleIds).toContain("std::mathdep");
  });

  it("invalidates the dependency snapshot when installed package source changes", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({ files: initial.files, roots: initial.roots, cache });

    const editedPkg = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 101 });
    const result = await loadAndAnalyze({
      files: editedPkg.files,
      roots: editedPkg.roots,
      cache,
    });

    expect(result.prepared.hit).toBe(false);
    expect(result.analyzed.recomputedModuleIds).toContain("pkg:dep::api");
  });

  it("captures all dependency modules before mixed-order source modules", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const srcRoot = resolve("/mixed/src");
    const stdRoot = resolve("/mixed/std");
    const roots = { src: srcRoot, std: stdRoot };
    const files = {
      [`${srcRoot}${sep}main.voyd`]: [
        "#!no_prelude",
        "use std::left::{ left_value }",
        "use src::helper::{ helper_value }",
        "use std::right::{ right_value }",
        "",
        "pub fn main() -> i32",
        "  left_value() + helper_value() + right_value()",
      ].join("\n"),
      [`${srcRoot}${sep}helper.voyd`]: [
        "#!no_prelude",
        "pub fn helper_value() -> i32",
        "  2",
      ].join("\n"),
      [`${stdRoot}${sep}left.voyd`]: [
        "#!no_prelude",
        "pub fn left_value() -> i32",
        "  1",
      ].join("\n"),
      [`${stdRoot}${sep}right.voyd`]: [
        "#!no_prelude",
        "pub fn right_value() -> i32",
        "  3",
      ].join("\n"),
    };

    await loadAndAnalyze({ files, roots, cache });

    const editedFiles = {
      ...files,
      [`${srcRoot}${sep}main.voyd`]: `${files[`${srcRoot}${sep}main.voyd`]}\nfn app_edit_marker() -> i32\n  4\n`,
    };
    const second = await loadAndAnalyze({ files: editedFiles, roots, cache });

    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual([
      "src::helper",
      "src::main",
    ]);
  });

  it("does not snapshot package modules with unresolved transitive dependencies", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const srcRoot = resolve("/unsafe/src");
    const pkgRoot = resolve("/unsafe/packages");
    const roots = { src: srcRoot, pkgDirs: [pkgRoot] };
    const files = {
      [`${srcRoot}${sep}main.voyd`]: [
        "#!no_prelude",
        "use pkg::dep::all",
        "",
        "pub fn main() -> i32",
        "  outer_value()",
      ].join("\n"),
      [`${srcRoot}${sep}helper.voyd`]: [
        "#!no_prelude",
        "pub fn helper_value() -> i32",
        "  1",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}pkg.voyd`]: [
        "#!no_prelude",
        "pub use src::outer::outer_value",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}outer.voyd`]: [
        "#!no_prelude",
        "use pkg::dep::inner::{ inner_value }",
        "",
        "pub fn outer_value() -> i32",
        "  inner_value() + 1",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}inner.voyd`]: [
        "#!no_prelude",
        "use src::missing::{ missing_value }",
        "",
        "pub fn inner_value() -> i32",
        "  missing_value() + 1",
      ].join("\n"),
    };

    const host = createMemoryHost(files);
    const graph = await loadModuleGraph({
      entryPath: `${roots.src}${sep}main.voyd`,
      roots,
      host,
    });
    const prepared = prepareDependencySnapshotReuse({ cache, graph, roots });
    const analyzed = analyzeModules({
      graph,
      captureDependencySnapshot: Boolean(prepared.key),
    });
    const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(analyzed.dependencySnapshot).toBeUndefined();
  });
});
