import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "../modules/types.js";
import {
  commitDependencySnapshot,
  createCompilerDependencySnapshotCache,
  exportCompilerDependencyBorrowArtifact,
  prepareDependencySnapshotReuse,
} from "../modules/dependency-snapshot-cache.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { projectPackageSemanticInterface } from "../semantics/borrowing/dependency-projection.js";
import { persistedBorrowQueryInput } from "../semantics/borrowing/query-digest.js";

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
    reusableBorrowing: prepared.reusableBorrowing,
    retainBorrowingIncrementalData: cache.artifactEnabled,
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

  it("omits borrowing reuse payloads when the caller cannot cache them", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const graph = await loadModuleGraph({
      entryPath: `${initial.roots.src}${sep}main.voyd`,
      roots: initial.roots,
      host: createMemoryHost(initial.files),
    });

    const analyzed = analyzeModules({
      graph,
      retainBorrowingIncrementalData: false,
    });

    expect(analyzed.diagnostics).toHaveLength(0);
    analyzed.semantics.forEach(({ borrowing }) => {
      expect(borrowing.queries).toBeUndefined();
      expect(borrowing.analysisMetrics).toBeUndefined();
      expect(borrowing.summaryDemand).toBeUndefined();
    });
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

  it("invalidates dependency semantics when the source import surface changes", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache,
    });
    const mainPath = `${initial.roots.src}${sep}main.voyd`;
    const changedMain = initial.files[mainPath]!
      .replace(
        "use pkg::dep::all",
        "use pkg::dep::{ pkg_value as selected_value }",
      )
      .replace("pkg_value()", "selected_value()");

    const second = await loadAndAnalyze({
      files: { ...initial.files, [mainPath]: changedMain },
      roots: initial.roots,
      cache,
    });

    expect(second.prepared.hit).toBe(false);
  });

  it("reuses dependency semantics without retaining borrowing artifact queries", async () => {
    const cache = createCompilerDependencySnapshotCache(undefined, {
      artifactEnabled: false,
    });
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const { analyzed } = await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache,
    });

    analyzed.semantics.forEach(({ borrowing }) => {
      expect(borrowing.queries).toBeUndefined();
    });
    expect(exportCompilerDependencyBorrowArtifact(cache)).toBeUndefined();
  });

  it("reuses versioned borrowing results in a fresh compiler cache", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const firstCache = createCompilerDependencySnapshotCache();
    await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache: firstCache,
    });
    expect(firstCache.borrowArtifact).toBeUndefined();
    const artifact = exportCompilerDependencyBorrowArtifact(firstCache);
    expect(artifact?.schema).toBe("voyd.compiler-dependency-borrow-cache");
    expect(artifact?.modules.length).toBeGreaterThan(0);
    expect(exportCompilerDependencyBorrowArtifact(firstCache)).toBe(artifact);

    const freshCache = createCompilerDependencySnapshotCache(
      JSON.parse(JSON.stringify(artifact)),
    );
    const second = await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache: freshCache,
    });

    expect(second.prepared.hit).toBe(false);
    expect(second.prepared.reusableBorrowing?.size).toBeGreaterThan(0);
    second.analyzed.semantics.forEach((semantics) => {
      const packageInterface = semantics.exports.packageSemanticInterface;
      expect(packageInterface?.schema).toBe("voyd.package-semantic-interface");
      expect(
        new Set(packageInterface?.summaries.map(({ id }) => id)).size,
      ).toBe(packageInterface?.summaries.length);
      semantics.exports.forEach((entry) => {
        entry.borrowing?.forEach((borrow) => {
          expect(
            packageInterface?.summaries.some(
              ({ id }) => id === borrow.summaryId,
            ),
          ).toBe(true);
        });
      });
    });
    expect(
      Array.from(second.analyzed.semantics.values()).flatMap((entry) =>
        Array.from(entry.borrowing.runtimeIdentityGuards.values()),
      ),
    ).toEqual(
      Array.from(
        (
          await loadAndAnalyze({
            files: initial.files,
            roots: initial.roots,
            cache: firstCache,
          })
        ).analyzed.semantics.values(),
      ).flatMap((entry) =>
        Array.from(entry.borrowing.runtimeIdentityGuards.values()),
      ),
    );
  });

  it("rejects malformed persisted borrowing artifacts as cache misses", () => {
    const malformed = {
      schema: "voyd.compiler-dependency-borrow-cache",
      version: "0.1.0:v448-package-borrow-cache-v2",
      key: "matching-key",
      modules: [{ moduleId: "std::bad", fingerprint: "x" }],
    };

    expect(
      exportCompilerDependencyBorrowArtifact(
        createCompilerDependencySnapshotCache(malformed as never),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed nested safety data in persisted artifacts", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const cache = createCompilerDependencySnapshotCache();
    await loadAndAnalyze({ files: initial.files, roots: initial.roots, cache });
    const artifact = JSON.parse(
      JSON.stringify(exportCompilerDependencyBorrowArtifact(cache)),
    );
    const rehash = (candidate: typeof artifact) => {
      candidate.payloadHash = persistedBorrowQueryInput(
        JSON.stringify(candidate.modules),
      );
    };
    artifact.modules[0].borrowing.namedContracts = [[1, {}]];
    rehash(artifact);

    expect(
      exportCompilerDependencyBorrowArtifact(
        createCompilerDependencySnapshotCache(artifact),
      ),
    ).toBeUndefined();

    const guardArtifact = JSON.parse(
      JSON.stringify(exportCompilerDependencyBorrowArtifact(cache)),
    );
    guardArtifact.modules[0].borrowing.runtimeIdentityGuards = [[1, [{}]]];
    rehash(guardArtifact);
    expect(
      exportCompilerDependencyBorrowArtifact(
        createCompilerDependencySnapshotCache(guardArtifact),
      ),
    ).toBeUndefined();

    const contractArtifact = JSON.parse(
      JSON.stringify(exportCompilerDependencyBorrowArtifact(cache)),
    );
    contractArtifact.modules[0].borrowing.callables[0][1].transfers = [
      { parameter: "invalid", path: [{ kind: "field" }] },
    ];
    rehash(contractArtifact);
    expect(
      exportCompilerDependencyBorrowArtifact(
        createCompilerDependencySnapshotCache(contractArtifact),
      ),
    ).toBeUndefined();

    const diagnosticArtifact = JSON.parse(
      JSON.stringify(exportCompilerDependencyBorrowArtifact(cache)),
    );
    diagnosticArtifact.modules[0].borrowing.diagnostics.push({
      code: "TY9999",
      message: "bad",
      severity: "error",
      span: { file: "bad", start: 0, end: 1 },
      phase: "invalid-phase",
      hints: [{}],
    });
    rehash(diagnosticArtifact);
    expect(
      exportCompilerDependencyBorrowArtifact(
        createCompilerDependencySnapshotCache(diagnosticArtifact),
      ),
    ).toBeUndefined();
  });

  it("invalidates changed dependency borrowing through reverse edges", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const initialCache = createCompilerDependencySnapshotCache();
    await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache: initialCache,
    });
    const artifact = exportCompilerDependencyBorrowArtifact(initialCache);
    const changed = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 101 });
    const host = createMemoryHost(changed.files);
    const graph = await loadModuleGraph({
      entryPath: `${changed.roots.src}${sep}main.voyd`,
      roots: changed.roots,
      host,
    });
    const prepared = prepareDependencySnapshotReuse({
      cache: createCompilerDependencySnapshotCache(
        JSON.parse(JSON.stringify(artifact)),
      ),
      graph,
      roots: changed.roots,
    });

    expect(prepared.reusableBorrowing?.has("std::mathdep")).toBe(true);
    expect(prepared.reusableBorrowing?.has("pkg:dep::api")).toBe(false);
    expect(prepared.reusableBorrowing?.has("pkg:dep")).toBe(false);
  });

  it("reuses callable query outputs after an unrelated module edit", async () => {
    const srcRoot = resolve("/callable-query/src");
    const roots = { src: srcRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const source = `#!no_prelude
obj Box { value: i32 }

fn project(value: borrow Box) -> borrow Box
  value

fn relay(value: borrow Box) -> borrow Box
  project(value)

pub fn main() -> i32
  let value = Box { value: 1 }
  relay(value).value
`;
    const firstGraph = await loadModuleGraph({
      entryPath: mainPath,
      roots,
      host: createMemoryHost({ [mainPath]: source }),
    });
    const first = analyzeModules({ graph: firstGraph });
    const firstDemand =
      first.semantics.get("src::main")?.borrowing.summaryDemand;
    expect(firstDemand?.evaluations).toBeGreaterThan(0);

    const secondGraph = await loadModuleGraph({
      entryPath: mainPath,
      roots,
      host: createMemoryHost({
        [mainPath]: source.replace("Box { value: 1 }", "Box { value: 2 }"),
      }),
    });
    const second = analyzeModules({
      graph: secondGraph,
      previousSemantics: first.semantics,
      typingState: first.typingState,
      changedModuleIds: new Set(["src::main"]),
    });
    const secondDemand =
      second.semantics.get("src::main")?.borrowing.summaryDemand;

    expect(second.diagnostics).toHaveLength(0);
    expect(secondDemand?.reusedCallables).toBeGreaterThan(0);
    expect(secondDemand?.evaluations).toBeLessThanOrEqual(
      firstDemand!.evaluations,
    );
  });

  it("emits a stable, independently consumable trait and effect interface", async () => {
    const srcRoot = resolve("/package-interface/src");
    const roots = { src: srcRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const publicSource = `#!no_prelude
pub obj PublicBox { api visible: i32, hidden: i32 }

pub trait Reader
  fn read(self, value: i32) -> i32
  fn read(self, value: bool) -> i32

@effect(id: "voyd.test.clock")
pub eff Clock
  now(resume) -> i32

pub fn identity(value: i32) -> i32
  value
`;
    const interfaceFor = async (privatePrefix: string) => {
      const graph = await loadModuleGraph({
        entryPath: mainPath,
        roots,
        host: createMemoryHost({
          [mainPath]: `#!no_prelude\n${privatePrefix}${publicSource.replace("#!no_prelude\n", "")}`,
        }),
      });
      const analyzed = analyzeModules({ graph });
      expect([...graph.diagnostics, ...analyzed.diagnostics]).toHaveLength(0);
      return analyzed.semantics.get("src::main")!.exports
        .packageSemanticInterface!;
    };

    const first = await interfaceFor("");
    const shifted = await interfaceFor(
      "fn private_marker(value: i32) -> i32\n  value\n\n",
    );
    const roundTripped = JSON.parse(JSON.stringify(first));
    const projected = projectPackageSemanticInterface(roundTripped);

    expect(shifted).toEqual(first);
    expect(
      first.exports.find((entry) => entry.name === "Reader")?.members,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read", kind: "trait-method" }),
        expect.objectContaining({ name: "read", kind: "trait-method" }),
      ]),
    );
    expect(
      first.exports.find((entry) => entry.name === "Clock")?.members,
    ).toEqual([
      expect.objectContaining({
        name: "now",
        kind: "effect-operation",
        resumable: "ctl",
      }),
    ]);
    expect(projected.callables.size).toBeGreaterThanOrEqual(4);
    expect(projected.effectOperations.size).toBe(1);
    expect(JSON.stringify(first)).toContain("visible");
    expect(JSON.stringify(first)).not.toContain("hidden");
  });

  it("reuses callers when an imported callable contract is unchanged", async () => {
    const srcRoot = resolve("/external-query/src");
    const stdRoot = resolve("/external-query/std");
    const roots = { src: srcRoot, std: stdRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const dependencyPath = `${stdRoot}${sep}box.voyd`;
    const source = `#!no_prelude
use std::box::{ Box, project }

fn relay(value: borrow Box) -> borrow Box
  project(value)

pub fn main() -> i32
  let value = Box { value: 1 }
  relay(value).value
`;
    const files = {
      [mainPath]: source,
      [dependencyPath]: `#!no_prelude
pub obj Box { api value: i32 }
pub fn project(value: borrow Box) -> borrow Box
  value
`,
    };
    const firstGraph = await loadModuleGraph({
      entryPath: mainPath,
      roots,
      host: createMemoryHost(files),
    });
    const first = analyzeModules({ graph: firstGraph });
    const secondGraph = await loadModuleGraph({
      entryPath: mainPath,
      roots,
      host: createMemoryHost({
        ...files,
        [mainPath]: source.replace("Box { value: 1 }", "Box { value: 2 }"),
      }),
    });
    const second = analyzeModules({
      graph: secondGraph,
      previousSemantics: first.semantics,
      typingState: first.typingState,
      changedModuleIds: new Set(["src::main"]),
    });

    expect(second.diagnostics).toHaveLength(0);
    expect(
      second.semantics.get("src::main")?.borrowing.summaryDemand
        ?.reusedCallables,
    ).toBeGreaterThan(0);
  });

  it("invalidates a flow caller when a compact callee output changes", async () => {
    const srcRoot = resolve("/compact-query/src");
    const roots = { src: srcRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const source = (reads: boolean) => `#!no_prelude
obj Box { value: i32 }

fn inspect(value: Box) -> i32
  ${reads ? "value.value" : "0"}

fn relay(value: borrow Box) -> borrow Box
  inspect(value)
  value

pub fn main() -> i32
  let value = Box { value: 1 }
  relay(value).value
`;
    const analyze = async (reads: boolean) => {
      const graph = await loadModuleGraph({
        entryPath: mainPath,
        roots,
        host: createMemoryHost({ [mainPath]: source(reads) }),
      });
      return { graph, analyzed: analyzeModules({ graph }) };
    };
    const first = await analyze(false);
    const firstSemantics = first.analyzed.semantics.get("src::main")!;
    const selectSymbol = Array.from(
      firstSemantics.borrowing.capabilities.keys(),
    ).find((symbol) => firstSemantics.symbols.getName(symbol) === "inspect")!;
    const relaySymbol = Array.from(
      firstSemantics.borrowing.capabilities.keys(),
    ).find((symbol) => firstSemantics.symbols.getName(symbol) === "relay")!;
    expect(firstSemantics.borrowing.capabilities.get(selectSymbol)).not.toBe(
      "flow-sensitive",
    );
    expect(firstSemantics.borrowing.capabilities.get(relaySymbol)).toBe(
      "flow-sensitive",
    );
    const firstRelayOutput =
      firstSemantics.borrowing.queries?.get(relaySymbol)?.output;

    const secondGraph = await loadModuleGraph({
      entryPath: mainPath,
      roots,
      host: createMemoryHost({ [mainPath]: source(true) }),
    });
    const second = analyzeModules({
      graph: secondGraph,
      previousSemantics: first.analyzed.semantics,
      typingState: first.analyzed.typingState,
      changedModuleIds: new Set(["src::main"]),
    });
    const secondSemantics = second.semantics.get("src::main")!;

    expect(second.diagnostics).toHaveLength(0);
    expect(
      secondSemantics.borrowing.queries?.get(relaySymbol)?.output,
    ).not.toEqual(firstRelayOutput);
    expect(
      secondSemantics.borrowing.summaryDemand?.evaluations,
    ).toBeGreaterThan(0);
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
