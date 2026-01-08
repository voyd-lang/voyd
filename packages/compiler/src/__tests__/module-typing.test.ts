import { describe, expect, it } from "vitest";
import { dirname, resolve, sep } from "node:path";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const registerPath = (path: string) => {
    const directParent = dirname(path);
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    const full = resolve(path);
    normalized.set(full, contents);
    registerPath(full);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    readFile: async (path: string) => {
      const resolved = resolve(path);
      const file = normalized.get(resolved);
      if (file === undefined) {
        throw new Error(`File not found: ${resolved}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolved = resolve(path);
      return Array.from(directories.get(resolved) ?? []);
    },
    fileExists: async (path: string) => normalized.has(resolve(path)),
    isDirectory: async (path: string) => isDirectoryPath(resolve(path)),
  };
};

describe("module typing across imports", () => {
  it("type-checks imported functions with their dependency signatures", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}math.voyd`]:
        "pub fn add(a: i32, b: i32) -> i32\n  a",
      [`${root}${sep}main.voyd`]:
        "use util::math::all\n\npub fn total(a: i32, b: i32) -> i32\n  add(a, b)",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const addImport = mainSemantics?.binding.imports.find(
      (entry) => entry.name === "add"
    );
    expect(addImport).toBeTruthy();

    const signature = addImport
      ? mainSemantics?.typing.functions.getSignature(addImport.local)
      : undefined;
    const firstParam = signature?.parameters[0]?.type;
    const paramDesc =
      typeof firstParam === "number"
        ? mainSemantics?.typing.arena.get(firstParam)
        : undefined;
    expect(paramDesc).toBeDefined();
    expect(paramDesc).toMatchObject({ kind: "primitive", name: "i32" });
    expect(diagnostics).toHaveLength(0);
  });

  it("raises a typing error when imported functions are called with incompatible types", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}math.voyd`]:
        "pub fn add(a: i32, b: i32) -> i32\n  a",
      [`${root}${sep}main.voyd`]:
        'use util::math::all\n\npub fn bad() i32\n  add("oops", 2)',
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((diag) => diag.code.startsWith("TY"))).toBe(true);
  });

  it("resolves pub use chains for imported types", async () => {
    const root = resolve("/proj/src");
    const hostFiles = {
      [`${root}${sep}shapes${sep}point.voyd`]:
        "pub obj Point { x: i32 }\n\npub fn new_point(x: i32) -> Point\n  Point { x }",
      [`${root}${sep}api.voyd`]: "pub use shapes::point::all",
      [`${root}${sep}consumer.voyd`]:
        "use api::all\n\npub fn origin(p: Point) -> Point\n  p\n\npub fn origin_point()\n  new_point(0)",
    };
    const host = createMemoryHost(hostFiles);

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}consumer.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const consumer = semantics.get("src::consumer");
    expect(
      consumer?.binding.imports.some((entry) => entry.name === "Point")
    ).toBe(true);
    expect(diagnostics).toHaveLength(0);
  });

  it("preserves TypeId identity for imported nominal types", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}shapes${sep}point.voyd`]:
        "pub obj Point { x: i32 }\n\npub fn make(x: i32) -> Point\n  Point { x }",
      [`${root}${sep}consumer.voyd`]:
        "use shapes::point::all\n\npub fn id(p: Point) -> Point\n  p",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}consumer.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);

    const pointModule = semantics.get("src::shapes::point");
    const consumerModule = semantics.get("src::consumer");
    expect(pointModule).toBeDefined();
    expect(consumerModule).toBeDefined();

    const pointSymbol = pointModule!.symbolTable.resolve(
      "Point",
      pointModule!.symbolTable.rootScope
    );
    expect(pointSymbol).toBeDefined();

    const pointType = pointModule!.typing.valueTypes.get(pointSymbol!);
    expect(pointType).toBeDefined();

    const idSymbol = consumerModule!.symbolTable.resolve(
      "id",
      consumerModule!.symbolTable.rootScope
    );
    expect(idSymbol).toBeDefined();

    const idSig = consumerModule!.typing.functions.getSignature(idSymbol!);
    const paramType = idSig?.parameters[0]?.type;
    expect(paramType).toBeDefined();

    expect(paramType).toBe(pointType);
  });

  it("type-checks inline modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}inline.voyd`]:
        "pub mod helpers\n  pub fn main() -> i32\n    1",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}inline.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const inline = semantics.get("src::inline");
    const inlineHelpers = semantics.get("src::inline::helpers");
    expect(inline).toBeDefined();
    expect(inlineHelpers).toBeDefined();
    expect(diagnostics).toHaveLength(0);
  });

  it("resolves nested module paths in expressions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}outer${sep}inner.voyd`]: "pub obj Foo { x: i32 }",
      [`${root}${sep}outer.voyd`]: "pub use inner::self",
      [`${root}${sep}main.voyd`]: `
use outer::self

pub fn main() -> i32
  let foo = outer::inner::Foo { x: 5 }
  foo.x
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);
  });
});
