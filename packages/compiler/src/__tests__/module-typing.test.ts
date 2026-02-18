import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleGraph, ModuleHost, ModulePath } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { DiagnosticError, type Diagnostic } from "../diagnostics/index.js";
import { modulePathToString } from "../modules/path.js";
import type { ModuleExportTable } from "../semantics/modules.js";
import {
  semanticsPipeline,
  type SemanticsPipelineResult,
} from "../semantics/pipeline.js";
import { createTypeArena } from "../semantics/typing/type-arena.js";
import { createEffectTable } from "../semantics/effects/effect-table.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const sortModules = (graph: ModuleGraph): string[] => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const moduleIdForPath = (path: ModulePath) => modulePathToString(path);

  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);

    const node = graph.modules.get(id);
    node?.dependencies.forEach((dep) => {
      const depId = moduleIdForPath(dep.path);
      if (graph.modules.has(depId)) {
        visit(depId);
      }
    });

    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  graph.modules.forEach((_, id) => visit(id));
  return order;
};

const analyzeModulesWithSharedInterners = ({
  graph,
}: {
  graph: ModuleGraph;
}): {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
} => {
  const order = sortModules(graph);
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];

  const arena = createTypeArena();
  const effects = createEffectTable();

  order.forEach((id) => {
    const module = graph.modules.get(id);
    if (!module) {
      return;
    }
    const result = semanticsPipeline({
      module,
      graph,
      exports,
      dependencies: semantics,
      typing: { arena, effects },
    });
    semantics.set(id, result);
    exports.set(id, result.exports);
    diagnostics.push(...result.diagnostics);
  });

  return { semantics, diagnostics };
};

const analyzeModulesWithIsolatedInterners = ({
  graph,
}: {
  graph: ModuleGraph;
}): {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
} => {
  const order = sortModules(graph);
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];

  order.forEach((id) => {
    const module = graph.modules.get(id);
    if (!module) {
      return;
    }
    try {
      const result = semanticsPipeline({
        module,
        graph,
        exports,
        dependencies: semantics,
      });
      semantics.set(id, result);
      exports.set(id, result.exports);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      if (error instanceof DiagnosticError) {
        diagnostics.push(...error.diagnostics);
        return;
      }
      throw error;
    }
  });

  return { semantics, diagnostics };
};

describe("module typing across imports", () => {
  it("type-checks imported functions with their dependency signatures", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}math.voyd`]:
        "pub fn add(a: i32, b: i32) -> i32\n  a",
      [`${root}${sep}main.voyd`]:
        "use src::util::math::all\n\npub fn total(a: i32, b: i32) -> i32\n  add(a, b)",
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
        'use src::util::math::all\n\npub fn bad() i32\n  add("oops", 2)',
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

  it("enforces imported generic constraints from dependency signatures", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}constraints.voyd`]: `
pub obj Animal { id: i32 }

pub fn accept<T: Animal>(value: T) -> i32
  value.id
`,
      [`${root}${sep}main.voyd`]: `
use src::util::constraints::all

pub fn main() -> i32
  accept({ id: 1 })
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(
      diagnostics.some((diag) =>
        /does not satisfy.*constraint/i.test(diag.message)
      )
    ).toBe(true);
  });

  it("resolves pub use chains for imported types", async () => {
    const root = resolve("/proj/src");
    const hostFiles = {
      [`${root}${sep}shapes${sep}point.voyd`]:
        "pub obj Point { x: i32 }\n\npub fn new_point(x: i32) -> Point\n  Point { x }",
      [`${root}${sep}api.voyd`]: "pub use src::shapes::point::all",
      [`${root}${sep}consumer.voyd`]:
        "use src::api::all\n\npub fn origin(p: Point) -> Point\n  p\n\npub fn origin_point()\n  new_point(0)",
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
        "use src::shapes::point::all\n\npub fn id(p: Point) -> Point\n  p",
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

    const pointSymbol = pointModule!.symbols.resolveTopLevel("Point");
    expect(pointSymbol).toBeDefined();

    const pointType = pointModule!.typing.valueTypes.get(pointSymbol!);
    expect(pointType).toBeDefined();

    const idSymbol = consumerModule!.symbols.resolveTopLevel("id");
    expect(idSymbol).toBeDefined();

    const idSig = consumerModule!.typing.functions.getSignature(idSymbol!);
    const paramType = idSig?.parameters[0]?.type;
    expect(paramType).toBeDefined();

    expect(paramType).toBe(pointType);
  });

  it("resolves imported nominal owners from signatures when interners are shared", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}a.voyd`]: `
pub obj Foo { x: i32 }

pub fn make() -> Foo
  Foo { x: 41 }
`,
      [`${root}${sep}main.voyd`]: `
use src::a::make

pub fn main() -> i32
  make().x
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModulesWithSharedInterners({ graph });
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
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
      [`${root}${sep}outer.voyd`]: "pub use self::inner",
      [`${root}${sep}main.voyd`]: `
use src::outer::self

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

  it("resolves nested module paths when exported via bare pub module-expression", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}outer${sep}inner.voyd`]: "pub obj Foo { x: i32 }",
      [`${root}${sep}outer.voyd`]: "pub self::inner",
      [`${root}${sep}main.voyd`]: `
use src::outer::self

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

  it("propagates outer generic args into namespaced nominal literals", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
type Wrap<T> = Marker<T>
obj Marker<T> { value: T }

pub fn main() -> i32
  let marker = Wrap<i32>::Marker { value: 5 }
  marker.value
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

  it("supports enum alias namespace access when alias is declared before variants", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
type Drink = Coffee | Tea
obj Coffee {}
obj Tea {}

pub fn main() -> Drink
  Drink::Coffee {}
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

  it("resolves imported enum namespaces used only in type positions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}drinks.voyd`]: `
pub obj Coffee {}
pub obj Tea {}
pub type Drink = Coffee | Tea
`,
      [`${root}${sep}main.voyd`]: `
use src::drinks::{ Drink }

pub fn takes(_: Drink::Coffee) -> i32
  1

pub fn main() -> i32
  1
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

  it("preserves concrete enum alias member type arguments across module boundaries", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}drinks.voyd`]: `
pub obj Coffee<T> {}
pub type Drink = Coffee<i32>
`,
      [`${root}${sep}main.voyd`]: `
use src::drinks::{ Drink }

pub fn takes(_: Drink::Coffee) -> i32
  1

pub fn main() -> i32
  let from_literal: Drink::Coffee = Drink::Coffee {}
  takes(from_literal)
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

  it("preserves fixed member args for generic enum namespace aliases", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
type Wrap<T> = Marker<T, i32>
obj Marker<T, U> { value: T, marker: U }

pub fn main() -> i32
  let wrapped: Wrap<bool>::Marker = Wrap<bool>::Marker { value: true, marker: 7 }
  wrapped.marker
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

  it("preserves outer generic args for namespaced type members", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
type Wrap<T> = Marker<T>
obj Marker<T> { value: T }

pub fn takes(_: Wrap<i32>::Marker) -> i32
  1

pub fn main() -> i32
  1
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

  it("rejects namespaced nominal literals for non-members", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
obj A1 { value: i32 }
obj B1 { value: i32 }
type B = B1

pub fn main() -> i32
  let value = B::A1 { value: 1 }
  value.value
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("resolves trait-object method calls for traits imported from another module", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::iterator
pub use self::counter
pub use std::counter::{ Counter, new_counter }
pub use std::iterator::{ Iterable, Iterator }
`,
      [`${stdRoot}${sep}iterator.voyd`]: `
pub trait Iterable
  fn iterate(self) -> Iterator

pub trait Iterator
  fn next(~self) -> i32
`,
      [`${stdRoot}${sep}counter.voyd`]: `
use std::iterator::all

pub obj Counter { value: i32 }

pub fn new_counter(value: i32) -> Counter
  Counter { value }

impl Iterable for Counter
  api fn iterate(self) -> Iterator
    self

impl Iterator for Counter
  api fn next(~self) -> i32
    self.value
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let ~iter = new_counter(7).iterate()
  iter.next()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);
  });

  it("resolves imported trait-object method calls when modules use isolated interners", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::iterator
pub use self::counter
pub use std::counter::{ Counter, new_counter }
pub use std::iterator::{ Iterable, Iterator }
`,
      [`${stdRoot}${sep}iterator.voyd`]: `
pub trait Iterable
  fn iterate(self) -> Iterator

pub trait Iterator
  fn next(~self) -> i32
`,
      [`${stdRoot}${sep}counter.voyd`]: `
use std::iterator::all

pub obj Counter { value: i32 }

pub fn new_counter(value: i32) -> Counter
  Counter { value }

impl Iterable for Counter
  api fn iterate(self) -> Iterator
    self

impl Iterator for Counter
  api fn next(~self) -> i32
    self.value
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let ~iter = new_counter(7).iterate()
  iter.next()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModulesWithIsolatedInterners({ graph });
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("resolves imported overloaded trait-object methods by signature", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::iterator
pub use self::counter
pub use std::counter::{ Counter, new_counter }
pub use std::iterator::{ Iterable, Iterator }
`,
      [`${stdRoot}${sep}iterator.voyd`]: `
pub trait Iterable
  fn iterate(self) -> Iterator

pub trait Iterator
  fn next(self) -> i32
  fn next(self, step: i32) -> i32
`,
      [`${stdRoot}${sep}counter.voyd`]: `
use std::iterator::all

pub obj Counter { value: i32 }

pub fn new_counter(value: i32) -> Counter
  Counter { value }

impl Iterable for Counter
  api fn iterate(self) -> Iterator
    self

impl Iterator for Counter
  api fn next(self) -> i32
    self.value

  api fn next(self, step: i32) -> i32
    self.value + step
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let iter = new_counter(7).iterate()
  iter.next() + iter.next(2)
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);
  });

  it("resolves imported overloaded trait-object methods by signature with isolated interners", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::iterator
pub use self::counter
pub use std::counter::{ Counter, new_counter }
pub use std::iterator::{ Iterable, Iterator }
`,
      [`${stdRoot}${sep}iterator.voyd`]: `
pub trait Iterable
  fn iterate(self) -> Iterator

pub trait Iterator
  fn next(self) -> i32
  fn next(self, step: i32) -> i32
`,
      [`${stdRoot}${sep}counter.voyd`]: `
use std::iterator::all

pub obj Counter { value: i32 }

pub fn new_counter(value: i32) -> Counter
  Counter { value }

impl Iterable for Counter
  api fn iterate(self) -> Iterator
    self

impl Iterator for Counter
  api fn next(self) -> i32
    self.value

  api fn next(self, step: i32) -> i32
    self.value + step
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let iter = new_counter(7).iterate()
  iter.next() + iter.next(2)
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModulesWithIsolatedInterners({ graph });
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("matches local impls against imported labeled trait overloads", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::router::{ Router }
`,
      [`${stdRoot}${sep}router.voyd`]: `
pub trait Router
  fn route(self, { from dest: i32 }) -> i32
  fn route(self, { to dest: i32 }) -> i32
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj Box { value: i32 }

impl Router for Box
  fn route(self, { from dest: i32 }) -> i32
    self.value + dest

  fn route(self, { to dest: i32 }) -> i32
    self.value - dest

fn apply(r: Router) -> i32
  r.route(from: 2) + r.route(to: 3)

pub fn main() -> i32
  apply(Box { value: 7 })
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModulesWithIsolatedInterners({ graph });
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("resolves imported instance methods inside module import cycles", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::a::b::all

pub fn main() -> i32
  bounce()
`,
      [`${root}${sep}a.voyd`]: `
pub obj Buffer {
  api bytes: i32
}

impl Buffer
  api fn byte_len(self) -> i32
    self.bytes
`,
      [`${root}${sep}a${sep}b.voyd`]: `
use src::a::all

pub fn bounce() -> i32
  Buffer { bytes: 3 }.byte_len()
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

  it("adds cycle-aware TY0022 hints for unresolved methods in cyclic modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::a::b::all

pub fn main() -> i32
  bounce()
`,
      [`${root}${sep}a.voyd`]: `
pub obj Buffer {
  api bytes: i32
}
`,
      [`${root}${sep}a${sep}b.voyd`]: `
use src::a::all

pub fn bounce() -> i32
  Buffer { bytes: 3 }.byte_len()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const unknownMethod = diagnostics.find((diagnostic) => diagnostic.code === "TY0022");
    expect(unknownMethod).toBeDefined();
    expect(
      unknownMethod?.hints?.some((hint) => /import cycle/i.test(hint.message)),
    ).toBe(true);
  });

  it("allows named macro re-exports in std package imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::iterator
pub use std::iterator::{ Iterable, Iterator, for }
`,
      [`${stdRoot}${sep}iterator.voyd`]: `
pub trait Iterable<T>
  fn iterate(self) -> Iterator<T>

pub trait Iterator<T>
  fn next(~self) -> i32

pub macro for(case)
  0
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);
  });
});
