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
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const loadAndAnalyze = async ({
  files,
  roots,
  cache,
  includeTests,
}: {
  files: Record<string, string>;
  roots: ModuleRoots;
  cache: ReturnType<typeof createCompilerDependencySnapshotCache>;
  includeTests?: boolean;
}) => {
  const host = createMemoryHost(files);
  const graph = await loadModuleGraph({
    entryPath: `${roots.src}${sep}main.voyd`,
    roots,
    host,
    includeTests,
  });
  const prepared = prepareDependencySnapshotReuse({
    cache,
    graph,
    roots,
    includeTests,
  });
  const analyzed = analyzeModules({
    graph,
    captureDependencySnapshot: Boolean(prepared.key),
    previousSemantics: prepared.previousSemantics,
    typingState: prepared.typingState,
    includeTests,
  });
  const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];
  expect(
    diagnostics,
    diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
  ).toHaveLength(0);
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

const mutatePlainContainers = (root: unknown, marker: symbol): void => {
  const seen = new Set<object>();
  const containers: object[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    const isContainer =
      Array.isArray(value) ||
      value instanceof Map ||
      value instanceof Set ||
      prototype === Object.prototype ||
      prototype === null;
    if (!isContainer) {
      return;
    }
    containers.push(value);
    if (value instanceof Map) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (value instanceof Set) {
      value.forEach(visit);
      return;
    }
    Reflect.ownKeys(value).forEach((key) =>
      visit((value as Record<PropertyKey, unknown>)[key]),
    );
  };
  visit(root);
  containers.forEach((container) => {
    if (container instanceof Map) {
      container.set(marker, marker);
      return;
    }
    if (container instanceof Set) {
      container.add(marker);
      return;
    }
    if (Array.isArray(container)) {
      container.push(marker);
      return;
    }
    (container as Record<PropertyKey, unknown>)[marker] = true;
  });
};

const containsMutationMarker = (root: unknown, marker: symbol): boolean => {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return false;
    }
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    const isContainer =
      Array.isArray(value) ||
      value instanceof Map ||
      value instanceof Set ||
      prototype === Object.prototype ||
      prototype === null;
    if (!isContainer) {
      return false;
    }
    if (value instanceof Map) {
      return value.has(marker) || Array.from(value.values()).some(visit);
    }
    if (value instanceof Set) {
      return value.has(marker) || Array.from(value).some(visit);
    }
    return (
      Object.prototype.hasOwnProperty.call(value, marker) ||
      Reflect.ownKeys(value).some((key) =>
        visit((value as Record<PropertyKey, unknown>)[key]),
      )
    );
  };
  return visit(root);
};

const assertRestoredTypingGraphCoherence = (
  semantics: SemanticsPipelineResult,
): void => {
  const symbolTable = getSymbolTable(semantics);
  const itemNamed = (name: string) =>
    Array.from(semantics.hir.items.values()).find(
      (item) =>
        "symbol" in item && symbolTable.getSymbol(item.symbol).name === name,
    );

  const genericFunction = itemNamed("read_generic");
  expect(genericFunction?.kind).toBe("function");
  if (genericFunction?.kind === "function") {
    expect(semantics.typing.functions.getFunction(genericFunction.symbol)).toBe(
      genericFunction,
    );
    const signature = semantics.typing.functions.getSignature(
      genericFunction.symbol,
    );
    expect(signature?.declaredReturnType).toBe(genericFunction.returnType);
    genericFunction.parameters.forEach((parameter, index) => {
      expect(signature?.parameters[index]?.declaredType).toBe(parameter.type);
      expect(signature?.parameters[index]?.span).toBe(parameter.span);
    });
  }

  const alias = itemNamed("BoxAlias");
  expect(alias?.kind).toBe("type-alias");
  if (alias?.kind === "type-alias") {
    const template = semantics.typing.typeAliases.getTemplate(alias.symbol);
    expect(template?.target).toBe(alias.target);
    alias.typeParameters?.forEach((parameter) => {
      expect(
        template?.params.find(
          (templateParameter) => templateParameter.symbol === parameter.symbol,
        )?.constraint,
      ).toBe(parameter.constraint);
    });
  }

  const nominalEntry = Array.from(
    semantics.typing.traitImplsByNominal.entries(),
  ).find(([, implementations]) => implementations.length > 0);
  expect(nominalEntry).toBeDefined();
  if (!nominalEntry) {
    return;
  }
  const [nominal, [implementation]] = nominalEntry;
  expect(semantics.typing.objects.getInstanceByNominal(nominal)).toBe(
    semantics.typing.objectsByNominal.get(nominal),
  );
  expect(
    semantics.typing.traitImplsByTrait
      .get(implementation!.traitSymbol)
      ?.find(
        (candidate) => candidate.implSymbol === implementation!.implSymbol,
      ),
  ).toBe(implementation);
  expect(
    semantics.typing.objectsByNominal
      .get(nominal)
      ?.traitImpls?.find(
        (candidate) => candidate.implSymbol === implementation!.implSymbol,
      ),
  ).toBe(implementation);
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
        "  let ~builder = PackageBuilder<i32> { value: 7, count: 0 }",
        "  builder.bump().bump().finish() + read(PackageBox { value: 7 })",
      ].join("\n"),
      [packageRootPath]: ["#!no_prelude", "pub use src::api::all"].join("\n"),
      [packageApiPath]: [
        "#!no_prelude",
        "pub obj PackageBox { api value: i32 }",
        "pub obj PackageBuilder<T> { api value: T, api count: i32 }",
        "",
        "impl<T> PackageBuilder<T>",
        "  api fn bump(~self) -> ~self",
        "    self.count = self.count + 1",
        "    self",
        "",
        "  api fn finish(~self) -> i32",
        "    self.count",
        "",
        "@result(detached)",
        "pub fn detached<T>(value: T) -> i32",
        "  0",
        "",
        "@result(fresh)",
        "pub fn fresh_box() -> PackageBox",
        "  PackageBox { value: 0 }",
        "",
        "pub fn replace(~value: i32) -> ~value",
        "  value",
        "",
        "@access(staged: out)",
        "pub fn copy_value(source: PackageBox, ~out: PackageBox) -> i32",
        "  let snapshot = source.value",
        "  out.value = snapshot",
        "  snapshot",
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

    const resultIdentityFor = (name: string) => {
      const declaration = packageInterface.exports.find(
        (entry) => entry.name === name,
      )?.declarations[0];
      expect(declaration?.signature).toBeDefined();
      const roundTripped = JSON.parse(JSON.stringify(packageInterface));
      return projectPackageSemanticInterface(roundTripped).callables.get(
        declaration!.key,
      )?.signature?.resultIdentity;
    };
    expect(resultIdentityFor("detached")).toEqual({ kind: "detached" });
    expect(resultIdentityFor("fresh_box")).toEqual({ kind: "fresh" });
    expect(resultIdentityFor("replace")).toEqual({
      kind: "same-place",
      parameterIndex: 0,
    });
    expect(
      packageInterface.exports.find((entry) => entry.name === "copy_value")
        ?.declarations[0]?.signature?.stagedAccess,
    ).toEqual({ destinationParameterIndex: 1 });

    const editedFiles = {
      ...files,
      [mainPath]: files[mainPath]!.replace("value: 7", "value: 8"),
    };
    const second = await loadAndAnalyze({ files: editedFiles, roots, cache });

    expect(second.prepared.hit).toBe(true);
    expect(second.analyzed.recomputedModuleIds).toEqual(["src::main"]);
    expect(
      second.analyzed.semantics
        .get("pkg:dep::api")!
        .exports.packageSemanticInterface!.exports.find(
          (entry) => entry.name === "detached",
        )?.declarations[0]?.signature?.resultIdentity,
    ).toEqual({ kind: "detached" });
    expect(
      second.analyzed.semantics
        .get("pkg:dep::api")!
        .exports.packageSemanticInterface!.exports.find(
          (entry) => entry.name === "copy_value",
        )?.declarations[0]?.signature?.stagedAccess,
    ).toEqual({ destinationParameterIndex: 1 });
  });

  it("isolates nested symbol metadata from cold results and every hit", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const project = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    const graph = await loadModuleGraph({
      entryPath: `${project.roots.src}${sep}main.voyd`,
      roots: project.roots,
      host: createMemoryHost(project.files),
    });
    const prepared = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const analyzed = analyzeModules({
      graph,
      captureDependencySnapshot: true,
    });
    const coldPackage = analyzed.semantics.get("pkg:dep::pkg")!;
    const exported = coldPackage.exports.get("pkg_value")!;
    commitDependencySnapshot({
      prepared,
      dependencySnapshot: analyzed.dependencySnapshot,
    });

    const coldMetadata = getSymbolTable(coldPackage).getSymbol(exported.symbol)
      .metadata as { import: { moduleId: string } };
    expect(coldMetadata.import.moduleId).toBe("pkg:dep::api");
    coldMetadata.import.moduleId = "cold-mutation";

    const first = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const firstPackage = first.previousSemantics!.get("pkg:dep::pkg")!;
    const firstMetadata = getSymbolTable(firstPackage).getSymbol(
      exported.symbol,
    ).metadata as { import: { moduleId: string } };
    expect(firstMetadata.import.moduleId).toBe("pkg:dep::api");
    firstMetadata.import.moduleId = "hit-mutation";

    const second = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const secondPackage = second.previousSemantics!.get("pkg:dep::pkg")!;
    expect(
      (
        getSymbolTable(secondPackage).getSymbol(exported.symbol).metadata as {
          import: { moduleId: string };
        }
      ).import.moduleId,
    ).toBe("pkg:dep::api");
  });

  it("restores an isolated mutable graph for every snapshot hit", async () => {
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

    const firstSemantics = firstReuse.previousSemantics!;
    const secondSemantics = secondReuse.previousSemantics!;
    firstSemantics.forEach((firstEntry, moduleId) => {
      const secondEntry = secondSemantics.get(moduleId)!;
      expect(firstEntry).not.toBe(secondEntry);
      expect(firstEntry.binding).not.toBe(secondEntry.binding);
      expect(firstEntry.binding.decls).not.toBe(secondEntry.binding.decls);
      expect(firstEntry.hir).not.toBe(secondEntry.hir);
      expect(firstEntry.hir.items).not.toBe(secondEntry.hir.items);
      expect(firstEntry.typing.arena).not.toBe(secondEntry.typing.arena);
      expect(firstEntry.typing.effects).not.toBe(secondEntry.typing.effects);
      expect(firstEntry.typing.table).not.toBe(secondEntry.typing.table);
      expect(firstEntry.typing.functions).not.toBe(
        secondEntry.typing.functions,
      );
      expect(firstEntry.typing.objects).not.toBe(secondEntry.typing.objects);
      expect(firstEntry.typing.traits).not.toBe(secondEntry.typing.traits);
      expect(firstEntry.typing.typeAliases).not.toBe(
        secondEntry.typing.typeAliases,
      );
      expect(firstEntry.borrowing).not.toBe(secondEntry.borrowing);
      expect(firstEntry.exports).not.toBe(secondEntry.exports);
      expect(getSymbolTable(firstEntry)).toBe(firstEntry.binding.symbolTable);
      expect(getSymbolTable(secondEntry)).toBe(secondEntry.binding.symbolTable);

      firstEntry.binding.dependencies.forEach((dependency, dependencyId) => {
        expect(dependency).toBe(firstSemantics.get(dependencyId)?.binding);
        expect(dependency).not.toBe(secondSemantics.get(dependencyId)?.binding);
      });
    });

    const marker = Symbol("snapshot-mutation-probe");
    mutatePlainContainers(firstSemantics, marker);
    expect(containsMutationMarker(secondSemantics, marker)).toBe(false);

    const secondArenaSize =
      secondApi!.typing.arena.snapshot().descriptors.length;
    const secondEffectRows =
      secondApi!.typing.effects.snapshotInterner().rows.length;
    const secondDeclCount = secondApi!.binding.decls.functions.length;
    firstApi!.typing.arena.internPrimitive("snapshot_probe");
    firstApi!.typing.effects.internRow({
      operations: [],
      tailVar: firstApi!.typing.effects.freshTailVar(),
    });
    firstApi!.typing.table.clearExprTypes();
    firstApi!.typing.functions.resetInstances();
    firstApi!.typing.objects.setName("snapshot_probe", -1);
    firstApi!.typing.typeAliases.markFailed("snapshot_probe");
    firstApi!.typing.traits.registerImplTemplate({
      trait: 0,
      traitSymbol: -1,
      target: 0,
      typeParams: [],
      methods: new Map(),
      staticMethods: new Map(),
      implSymbol: -1,
    });
    firstApi!.binding.decls.functions.length = 0;

    expect(secondApi!.typing.arena.snapshot().descriptors).toHaveLength(
      secondArenaSize,
    );
    expect(secondApi!.typing.effects.snapshotInterner().rows).toHaveLength(
      secondEffectRows,
    );
    expect(
      secondApi!.typing.objects.resolveName("snapshot_probe"),
    ).toBeUndefined();
    expect(secondApi!.typing.typeAliases.hasFailed("snapshot_probe")).toBe(
      false,
    );
    expect(secondApi!.typing.traits.getImplTemplates()).toHaveLength(0);
    expect(secondApi!.binding.decls.functions).toHaveLength(secondDeclCount);

    const thirdReuse = prepareDependencySnapshotReuse({
      cache,
      graph,
      roots: project.roots,
    });
    const thirdApi = thirdReuse.previousSemantics?.get("pkg:dep::api");
    expect(thirdReuse.hit).toBe(true);
    expect(thirdApi!.typing.arena.snapshot().descriptors).toHaveLength(
      secondArenaSize,
    );
    expect(thirdApi!.typing.effects.snapshotInterner().rows).toHaveLength(
      secondEffectRows,
    );
    expect(thirdApi!.binding.decls.functions).toHaveLength(secondDeclCount);
    expect(
      thirdApi!.typing.objects.resolveName("snapshot_probe"),
    ).toBeUndefined();
    expect(thirdApi!.typing.typeAliases.hasFailed("snapshot_probe")).toBe(
      false,
    );
    expect(thirdApi!.typing.traits.getImplTemplates()).toHaveLength(0);
  });

  it("keeps import and hydration edits order-independent across warm hits", async () => {
    const srcRoot = resolve("/hydration-order/src");
    const pkgRoot = resolve("/hydration-order/packages");
    const roots = { src: srcRoot, pkgDirs: [pkgRoot] };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const baseFiles = {
      [`${pkgRoot}${sep}dep${sep}src${sep}pkg.voyd`]: [
        "#!no_prelude",
        "pub use src::api::all",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}api.voyd`]: [
        "#!no_prelude",
        "pub trait Readable",
        "  fn read(self) -> i32",
        "",
        "pub obj Box { api value: i32 }",
        "",
        "impl Readable for Box",
        "  fn read(self) -> i32",
        "    self.value",
        "",
        "pub type BoxAlias<T: { value: i32 }> = T",
        "",
        '@effect(id: "voyd.test.snapshot-clock")',
        "pub eff SnapshotClock",
        "  adjust(resume, value: i32) -> i32",
        "  adjust(resume, value: bool) -> i32",
        "",
        "pub fn read_generic<T: Readable>(value: T) -> i32",
        "  value.read()",
        "",
        "pub fn alias_value(value: BoxAlias<Box>) -> i32",
        "  value.value",
        "",
        "pub fn pkg_value() -> i32",
        "  2",
      ].join("\n"),
      [`${pkgRoot}${sep}dep${sep}src${sep}api.test.voyd`]: [
        "#!no_prelude",
        'test "dependency snapshot overlay":',
        "  void",
      ].join("\n"),
    };
    const effectHandler = (effectName: string) => [
      "fn adjusted(value: i32) -> i32",
      "  try",
      `    ${effectName}::adjust(value)`,
      `  ${effectName}::adjust(resume, value: i32):`,
      "    resume(value)",
      `  ${effectName}::adjust(resume, value: bool):`,
      "    resume(0)",
    ];
    const variants = new Map([
      [
        "wildcard",
        [
          "#!no_prelude",
          "use pkg::dep::all",
          ...effectHandler("SnapshotClock"),
          "pub fn main() -> i32",
          "  adjusted(read_generic(Box { value: 40 })) + alias_value(Box { value: 0 }) + pkg_value()",
        ].join("\n"),
      ],
      [
        "selected",
        [
          "#!no_prelude",
          "use pkg::dep::{ Box, BoxAlias, SnapshotClock, alias_value, read_generic, pkg_value }",
          ...effectHandler("SnapshotClock"),
          "pub fn main() -> i32",
          "  adjusted(read_generic(Box { value: 40 })) + alias_value(Box { value: 0 }) + pkg_value()",
        ].join("\n"),
      ],
      [
        "aliased",
        [
          "#!no_prelude",
          "use pkg::dep::{ Box, BoxAlias as Alias, SnapshotClock as Clock, alias_value as alias_read, read_generic as read, pkg_value as value }",
          ...effectHandler("Clock"),
          "pub fn main() -> i32",
          "  adjusted(read(Box { value: 40 })) + alias_read(Box { value: 0 }) + value()",
          "fn private_body_edit() -> i32",
          "  1",
        ].join("\n"),
      ],
      [
        "private-edit",
        [
          "#!no_prelude",
          "use pkg::dep::all",
          ...effectHandler("SnapshotClock"),
          "pub fn main() -> i32",
          "  adjusted(read_generic(Box { value: 40 })) + alias_value(Box { value: 0 }) + pkg_value()",
          "fn private_body_edit() -> i32",
          "  2",
        ].join("\n"),
      ],
    ]);
    const compileSequence = async ({
      order,
      includeTests = false,
      reuseCache = true,
    }: {
      order: readonly string[];
      includeTests?: boolean;
      reuseCache?: boolean;
    }) => {
      const cache = createCompilerDependencySnapshotCache();
      const results = new Map<
        string,
        { diagnostics: readonly string[]; packageInterface: unknown }
      >();
      const hits: boolean[] = [];
      for (const name of order) {
        const result = await loadAndAnalyze({
          files: { ...baseFiles, [mainPath]: variants.get(name)! },
          roots,
          cache: reuseCache ? cache : createCompilerDependencySnapshotCache(),
          includeTests,
        });
        hits.push(result.prepared.hit);
        assertRestoredTypingGraphCoherence(
          result.analyzed.semantics.get("pkg:dep::api")!,
        );
        results.set(name, {
          diagnostics: result.analyzed.diagnostics.map(
            (diagnostic) => diagnostic.code,
          ),
          packageInterface:
            result.analyzed.semantics.get("pkg:dep::api")!.exports
              .packageSemanticInterface,
        });
      }
      return { results, hits };
    };
    const order = [...variants.keys()];
    const forward = await compileSequence({ order });
    const reverse = await compileSequence({ order: [...order].reverse() });
    const fresh = await compileSequence({ order, reuseCache: false });
    const testForward = await compileSequence({ order, includeTests: true });
    const testReverse = await compileSequence({
      order: [...order].reverse(),
      includeTests: true,
    });
    const freshTests = await compileSequence({
      order,
      includeTests: true,
      reuseCache: false,
    });
    const noOp = await compileSequence({
      order: ["wildcard", "wildcard", "wildcard"],
    });

    order.forEach((name) => {
      expect(forward.results.get(name)).toEqual(reverse.results.get(name));
      expect(forward.results.get(name)).toEqual(fresh.results.get(name));
      expect(testForward.results.get(name)).toEqual(
        testReverse.results.get(name),
      );
      expect(testForward.results.get(name)).toEqual(
        freshTests.results.get(name),
      );
      expect(forward.results.get(name)?.diagnostics).toEqual([]);
      expect(testForward.results.get(name)?.diagnostics).toEqual([]);
    });
    expect(forward.hits).toEqual([false, true, true, true]);
    expect(fresh.hits).toEqual([false, false, false, false]);
    expect(noOp.hits).toEqual([false, true, true]);
  });

  it("emits a stable, independently consumable trait and effect interface", async () => {
    const srcRoot = resolve("/package-interface/src");
    const roots = { src: srcRoot };
    const mainPath = `${srcRoot}${sep}main.voyd`;
    const publicSource = `#!no_prelude
pub obj PublicBox { api visible: i32, hidden: i32 }

pub trait Reader
  @result(detached)
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

@access(staged: out)
pub fn copy_value(source: PublicBox, ~out: PublicBox) -> i32
  let snapshot = source.visible
  out.visible = snapshot
  snapshot

@access(builder: out)
pub fn build_value(source: PublicBox, ~out: PublicBox) -> void
  out.visible = source.visible
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
    expect(
      first.exports
        .find((entry) => entry.name === "Reader")
        ?.members.find((member) => member.resultIdentity?.kind === "detached")
        ?.resultIdentity,
    ).toEqual({ kind: "detached" });
    const detachedTraitMethod = first.exports
      .find((entry) => entry.name === "Reader")
      ?.members.find((member) => member.resultIdentity?.kind === "detached");
    expect(
      projected.callables.get(detachedTraitMethod!.key)?.resultIdentity,
    ).toEqual({ kind: "detached" });
    const stagedDeclaration = first.exports.find(
      (entry) => entry.name === "copy_value",
    )?.declarations[0];
    expect(stagedDeclaration?.signature?.stagedAccess).toEqual({
      destinationParameterIndex: 1,
    });
    expect(
      projected.callables.get(stagedDeclaration!.key)?.signature?.stagedAccess,
    ).toEqual({ destinationParameterIndex: 1 });
    const builderDeclaration = first.exports.find(
      (entry) => entry.name === "build_value",
    )?.declarations[0];
    expect(builderDeclaration?.signature?.builderAccess).toEqual({
      destinationParameterIndex: 1,
    });
    expect(
      projected.callables.get(builderDeclaration!.key)?.signature
        ?.builderAccess,
    ).toEqual({ destinationParameterIndex: 1 });
    const isolatedSummaryId = first.exports
      .find((entry) => entry.name === "Reader")
      ?.members.find(
        (member) => member.name === "stable",
      )?.ordinaryMutationSummaryId;
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
    expect(first.version).toBe(5);
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

  it("invalidates the dependency snapshot for test overlays and root changes", async () => {
    const cache = createCompilerDependencySnapshotCache();
    const project = buildFiles({ appValue: 1, stdValue: 10, pkgValue: 100 });
    await loadAndAnalyze({ files: project.files, roots: project.roots, cache });
    const graph = await loadModuleGraph({
      entryPath: `${project.roots.src}${sep}main.voyd`,
      roots: project.roots,
      host: createMemoryHost(project.files),
    });

    expect(
      prepareDependencySnapshotReuse({
        cache,
        graph,
        roots: project.roots,
        includeTests: true,
      }).hit,
    ).toBe(false);
    expect(
      prepareDependencySnapshotReuse({
        cache,
        graph,
        roots: {
          ...project.roots,
          pkgDirs: [...(project.roots.pkgDirs ?? []), resolve("/other-pkgs")],
        },
      }).hit,
    ).toBe(false);
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
