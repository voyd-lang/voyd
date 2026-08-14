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
import { projectPackageSemanticInterface } from "../semantics/borrowing/dependency-projection.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";

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

  it("omits borrowing query payloads from semantic results", async () => {
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const graph = await loadModuleGraph({
      entryPath: `${initial.roots.src}${sep}main.voyd`,
      roots: initial.roots,
      host: createMemoryHost(initial.files),
    });

    const analyzed = analyzeModules({ graph });

    expect(analyzed.diagnostics).toHaveLength(0);
    analyzed.semantics.forEach(({ borrowing }) => {
      expect("queries" in borrowing).toBe(false);
      expect("analysisMetrics" in borrowing).toBe(false);
      expect("summaryDemand" in borrowing).toBe(false);
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

  it("reuses dependency semantics when the source import surface changes", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const initial = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({
      files: initial.files,
      roots: initial.roots,
      cache,
    });
    const mainPath = `${initial.roots.src}${sep}main.voyd`;
    const changedMain = initial.files[mainPath]!.replace(
      "use pkg::dep::all",
      "use pkg::dep::{ pkg_value as selected_value }",
    ).replace("pkg_value()", "selected_value()");

    const second = await loadAndAnalyze({
      files: { ...initial.files, [mainPath]: changedMain },
      roots: initial.roots,
      cache,
    });

    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
  });

  it("reuses a public package Borrow input through its finite interface", async () => {
    const srcRoot = resolve("/borrow-package/src");
    const pkgRoot = resolve("/borrow-package/packages");
    const roots = { src: srcRoot, pkgDirs: [pkgRoot] };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const packageRootPath = `${pkgRoot}${sep}dep${sep}src${sep}pkg.voyd`;
    const packageApiPath = `${pkgRoot}${sep}dep${sep}src${sep}api.voyd`;
    const files = {
      [mainPath]: [
        "#!no_prelude",
        "use pkg::dep::all",
        "",
        "pub fn main() -> i32",
        "  read(PackageBox { value: 7 })",
      ].join("\n"),
      [packageRootPath]: ["#!no_prelude", "pub use src::api::all"].join("\n"),
      [packageApiPath]: [
        "#!no_prelude",
        "pub obj PackageBox { api value: i32 }",
        "",
        "pub fn read(value: Borrow<PackageBox>) -> i32",
        "  value.value",
      ].join("\n"),
    };
    const cache = createCompilerDependencySnapshotCache();
    const first = await loadAndAnalyze({ files, roots, cache });
    const packageInterface =
      first.analyzed.semantics.get("pkg:dep::api")!.exports
        .packageSemanticInterface!;
    const readExport = packageInterface.exports.find(
      (entry) => entry.name === "read",
    );

    expect(readExport).toBeDefined();
    const readParameterType =
      readExport!.declarations[0]!.signature!.parameters[0]!.type;
    expect(
      packageInterface.types.find((type) => type.id === readParameterType)
        ?.descriptor,
    ).toEqual(expect.objectContaining({ kind: "borrowed" }));
    expect(readExport).not.toHaveProperty("borrowing");
    expect(packageInterface).not.toHaveProperty("summaries");
    expect(packageInterface).not.toHaveProperty("coercions");

    const editedFiles = {
      ...files,
      [mainPath]: files[mainPath]!.replace("value: 7", "value: 8"),
    };
    const second = await loadAndAnalyze({ files: editedFiles, roots, cache });

    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
  });

  it("isolates lazy source-import metadata between snapshot hits", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const project = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({ files: project.files, roots: project.roots, cache });
    const graph = await loadModuleGraph({
      entryPath: `${project.roots.src}${sep}main.voyd`,
      roots: project.roots,
      host: createMemoryHost(project.files),
    });

    const firstReuse = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const firstApi = firstReuse.previousSemantics?.get("pkg:dep::api");
    const exported = firstApi?.exports.get("pkg_value");
    expect(firstReuse.hit).toBe(true);
    expect(firstApi).toBeDefined();
    expect(exported).toBeDefined();
    getSymbolTable(firstApi!).setSymbolMetadata(exported!.symbol, {
      sourceHydrationProbe: true,
    });

    const secondReuse = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const secondApi = secondReuse.previousSemantics?.get("pkg:dep::api");
    const secondSymbolTable = getSymbolTable(secondApi!);

    expect(secondReuse.hit).toBe(true);
    expect(
      secondSymbolTable.getSymbol(exported!.symbol).metadata,
    ).not.toHaveProperty("sourceHydrationProbe");
    expect(secondApi?.binding.symbolTable).toBe(secondSymbolTable);
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
  @isolated
  fn stable(self): () -> i32

@effect(id: "voyd.test.clock")
pub eff Clock
  now(resume) -> i32

pub fn identity(value: i32) -> i32
  value

pub fn defaulted(value: i32 = 0) -> i32
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
        expect.objectContaining({ name: "stable", kind: "trait-method" }),
      ]),
    );
    const isolatedSummaryId = first.exports
      .find((entry) => entry.name === "Reader")
      ?.members.find((member) => member.name === "stable")
      ?.ordinaryMutationSummaryId;
    const isolatedSummary = first.ordinaryMutationSummaries.find(
      (entry) => entry.id === isolatedSummaryId,
    )?.summary;
    expect(isolatedSummary).toEqual(
      expect.objectContaining({
        ambientAccess: 0,
        reentrant: false,
        maySuspend: false,
      }),
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
    expect(
      Array.from(projected.callables.values()).filter(
        (callable) => callable.ordinaryMutationSummary !== undefined,
      ).length,
    ).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(first)).toContain("visible");
    expect(JSON.stringify(first)).not.toContain("hidden");
    expect(first.version).toBe(4);
    expect(first.ordinaryMutationSummaries.length).toBeGreaterThan(0);
    first.ordinaryMutationSummaries.forEach(({ summary }) => {
      expect(Object.keys(summary).sort()).toEqual([
        "ambientAccess",
        "directAccesses",
        "maySuspend",
        "reachableAccesses",
        "reentrant",
      ]);
      expect(summary.directAccesses).toHaveLength(
        summary.reachableAccesses.length,
      );
    });
    expect(projectPackageSemanticInterface(roundTripped)).toEqual(projected);
    expect(() =>
      projectPackageSemanticInterface({
        ...roundTripped,
        version: 3,
      } as Parameters<typeof projectPackageSemanticInterface>[0]),
    ).toThrow(/unsupported package semantic interface/);
    expect(first).not.toHaveProperty("summaries");
    expect(first).not.toHaveProperty("coercions");
    expect(first).not.toHaveProperty("callableResultCoercions");
    expect(first).not.toHaveProperty("traitImplementations");
    expect(JSON.stringify(first)).not.toContain("freshResult");
    expect(
      first.exports.find((entry) => entry.name === "defaulted")?.declarations[0]
        ?.defaultIdentityGuardProtocol,
    ).toBe("presence-conflict-bit-v1");
    const defaulted = first.exports.find(
      (entry) => entry.name === "defaulted",
    )!;
    expect(
      projected.callables.get(defaulted.declarations[0]!.key)
        ?.defaultIdentityGuardProtocol,
    ).toBe("presence-conflict-bit-v1");
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
