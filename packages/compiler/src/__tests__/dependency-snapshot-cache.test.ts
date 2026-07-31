import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "../modules/types.js";
import {
  commitDependencySnapshot,
  createCompilerDependencySnapshotCache,
  preparePrecompiledDependencySnapshot,
  prepareDependencySnapshotReuse,
} from "../modules/dependency-snapshot-cache.js";
import {
  encodePrecompiledStdSnapshot,
  restorePrecompiledStdSnapshot,
} from "../modules/precompiled-std-snapshot.js";
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

  it("restores std graph and semantic state without reading dependency source", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const stdOnlyRoots = {
      src: initial.roots.src,
      std: initial.roots.std,
    };
    const graph = await loadModuleGraph({
      entryPath: `${stdOnlyRoots.src}${sep}main.voyd`,
      roots: stdOnlyRoots,
      host: createMemoryHost({
        [`${stdOnlyRoots.src}${sep}main.voyd`]: [
          "#!no_prelude",
          "use std::mathdep::{ std_value }",
          "pub fn main() -> i32",
          "  std_value() + 1",
        ].join("\n"),
        [`${stdOnlyRoots.std}${sep}mathdep.voyd`]:
          initial.files[`${initial.roots.std}${sep}mathdep.voyd`]!,
      }),
    });
    const analyzed = analyzeModules({
      graph,
      captureDependencySnapshot: true,
    });
    expect(analyzed.diagnostics).toHaveLength(0);
    expect(analyzed.dependencySnapshot).toBeDefined();

    const encoded = encodePrecompiledStdSnapshot({
      graphModules: graph.modules,
      dependencySnapshot: analyzed.dependencySnapshot!,
      stdRoot: stdOnlyRoots.std,
    });
    const restored = restorePrecompiledStdSnapshot({
      encoded,
      stdRoot: stdOnlyRoots.std,
    });
    const sourceOnlyHost = createMemoryHost({
      [`${stdOnlyRoots.src}${sep}main.voyd`]: [
        "#!no_prelude",
        "use std::mathdep::{ std_value }",
        "pub fn main() -> i32",
        "  std_value() + 2",
      ].join("\n"),
    });
    const restoredGraph = await loadModuleGraph({
      entryPath: `${stdOnlyRoots.src}${sep}main.voyd`,
      roots: stdOnlyRoots,
      host: sourceOnlyHost,
      preloadedModules: restored.modules,
    });
    const prepared = preparePrecompiledDependencySnapshot({
      graph: restoredGraph,
      snapshot: restored.dependencySnapshot,
      liveTypingState: restored.typingState,
    });
    expect(prepared.typingState).toBe(restored.typingState);
    expect(prepared.previousSemantics.get("std::mathdep")).toBe(
      restored.dependencySnapshot.semantics.get("std::mathdep"),
    );
    const second = analyzeModules({
      graph: restoredGraph,
      previousSemantics: prepared.previousSemantics,
      typingState: prepared.typingState,
    });

    expect(second.diagnostics).toHaveLength(0);
    expect(second.recomputedModuleIds).toEqual(["src::main"]);
    expect(second.semantics.get("std::mathdep")?.typing.arena).toBe(
      second.typingState.arena,
    );
    expect(
      second.semantics.get("std::mathdep")?.exports.get("std_value")
        ?.borrowing?.[0]?.serialized,
    ).toBeDefined();
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

  it("preserves trait coercion summaries across dependency snapshot hits", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const srcRoot = resolve("/view-cache/src");
    const stdRoot = resolve("/view-cache/std");
    const roots = { src: srcRoot, std: stdRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const files = {
      [mainPath]: `#!no_prelude
use std::views::{ State, View, make_state }

pub fn main() -> i32
  let ~state = make_state()
  let view: View = state
  let item = view.get()
  state.source.value = 2
  item.value
`,
      [`${stdRoot}${sep}views.voyd`]: `#!no_prelude
pub obj Item { api value: i32 }
pub obj State { api source: Item }

pub trait View
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make_state() -> State
  State { source: Item { value: 1 } }

`,
    };
    const analyzeWithCache = async (sources: Record<string, string>) => {
      const graph = await loadModuleGraph({
        entryPath: mainPath,
        roots,
        host: createMemoryHost(sources),
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
      commitDependencySnapshot({
        prepared,
        dependencySnapshot: analyzed.dependencySnapshot,
      });
      return {
        prepared,
        analyzed,
        diagnostics: [...graph.diagnostics, ...analyzed.diagnostics],
      };
    };

    const first = await analyzeWithCache(files);
    expect(first.prepared.hit).toBe(false);
    expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
    expect(
      first.analyzed.semantics.get("std::views")?.exports
        .borrowingTraitImplementations?.length,
    ).toBeGreaterThan(0);

    const second = await analyzeWithCache({
      ...files,
      [mainPath]: `${files[mainPath]}\nfn edit_marker() -> i32\n  0\n`,
    });
    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
    expect(
      second.analyzed.semantics.get("std::views")?.exports
        .borrowingTraitImplementations?.length,
    ).toBeGreaterThan(0);
  });

  it("preserves callable-result and result-path summaries across dependency snapshot hits", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const srcRoot = resolve("/callback-cache/src");
    const stdRoot = resolve("/callback-cache/std");
    const roots = { src: srcRoot, std: stdRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const files = {
      [mainPath]: `#!no_prelude
use std::views::{ Item, View, apply, create_pair, identity_default }

obj LocalState { source: Item }

impl View for LocalState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make_view() -> View
  apply(() => LocalState { source: Item { value: 3 } })

pub fn select_view() -> View
  create_pair().selected

pub fn default_view() -> View
  let factory = identity_default()
  factory()

pub fn main() -> i32
  make_view().get().value +
    select_view().get().value +
    default_view().get().value
`,
      [`${stdRoot}${sep}views.voyd`]: `#!no_prelude
pub obj Item { api value: i32 }
pub obj Pair { api selected: View, api ignored: View }

pub trait View
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

obj UsedState { source: Item }
obj UnusedState { source: Item }
obj DefaultState { source: Item }

impl View for UsedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for UnusedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(factory: fn() -> View) -> View
  factory()

pub fn create_pair() -> Pair
  Pair {
    selected: UsedState { source: Item { value: 5 } },
    ignored: UnusedState { source: Item { value: 7 } }
  }

pub fn identity_default(
  factory: fn() -> View = () => DefaultState {
    source: Item { value: 11 }
  }
) -> (fn() : () -> View)
  factory
`,
    };
    const first = await loadAndAnalyze({ files, roots, cache });
    const firstMain = first.analyzed.semantics.get("src::main");
    const firstViews = first.analyzed.semantics.get("std::views");
    expect(first.prepared.hit).toBe(false);
    expect(
      Array.from(firstMain?.exports.values() ?? [])
        .find((entry) => entry.name === "make_view")
        ?.borrowingCoercions?.map((coercion) => coercion.concrete.moduleId),
    ).toEqual(["src::main"]);
    expect(
      Array.from(firstMain?.exports.values() ?? [])
        .find((entry) => entry.name === "select_view")
        ?.borrowingCoercions?.map((coercion) =>
          firstViews?.symbols.getName(coercion.concrete.symbol),
        ),
    ).toEqual(["UsedState"]);
    expect(
      Array.from(firstMain?.exports.values() ?? [])
        .find((entry) => entry.name === "default_view")
        ?.borrowingCoercions?.map((coercion) =>
          firstViews?.symbols.getName(coercion.concrete.symbol),
        ),
    ).toEqual(["DefaultState"]);

    const second = await loadAndAnalyze({
      files: {
        ...files,
        [mainPath]: `${files[mainPath]}\nfn edit_marker() -> i32\n  0\n`,
      },
      roots,
      cache,
    });
    const secondMain = second.analyzed.semantics.get("src::main");
    const secondViews = second.analyzed.semantics.get("std::views");
    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
    expect(
      Array.from(secondMain?.exports.values() ?? [])
        .find((entry) => entry.name === "make_view")
        ?.borrowingCoercions?.map((coercion) => coercion.concrete.moduleId),
    ).toEqual(["src::main"]);
    expect(
      Array.from(secondMain?.exports.values() ?? [])
        .find((entry) => entry.name === "select_view")
        ?.borrowingCoercions?.map((coercion) =>
          secondViews?.symbols.getName(coercion.concrete.symbol),
        ),
    ).toEqual(["UsedState"]);
    expect(
      Array.from(secondMain?.exports.values() ?? [])
        .find((entry) => entry.name === "default_view")
        ?.borrowingCoercions?.map((coercion) =>
          secondViews?.symbols.getName(coercion.concrete.symbol),
        ),
    ).toEqual(["DefaultState"]);
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
