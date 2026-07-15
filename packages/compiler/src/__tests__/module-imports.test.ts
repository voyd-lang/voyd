import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("module imports", () => {
  it("binds imports across modules using the module graph exports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use src::util::math::all\npub fn main() 1",
      [`${root}${sep}util${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const mathSemantics = semantics.get("src::util::math");

    expect(mainSemantics?.binding.imports.map((imp) => imp.name)).toContain(
      "add"
    );
    expect(mathSemantics?.exports.has("add")).toBe(true);
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("resolves relative module imports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}util${sep}foo.voyd`]: "pub fn id() -> i32 7",
      [`${root}${sep}util${sep}bar.voyd`]:
        "use super::foo\npub fn main() -> i32\n  foo::id()",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}util${sep}bar.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const barId = "src::util::bar";
    const fooId = "src::util::foo";

    expect(graph.modules.has(barId)).toBe(true);
    expect(graph.modules.has(fooId)).toBe(true);
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("supports cyclic imports for declaration surfaces", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::a::all",
        "use src::b::all",
        "",
        "pub fn main() -> i32",
        "  takes_b(B {}) + takes_a(A {})",
      ].join("\n"),
      [`${root}${sep}a.voyd`]: [
        "use src::b::B",
        "",
        "pub obj A {}",
        "",
        "pub fn takes_b(_value: B) -> i32",
        "  1",
      ].join("\n"),
      [`${root}${sep}b.voyd`]: [
        "use src::a::A",
        "",
        "pub obj B {}",
        "",
        "pub fn takes_a(_value: A) -> i32",
        "  2",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("supports cyclic imports when trait and object declarations reference each other", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::a::A",
        "",
        "pub fn main() -> i32",
        "  0",
      ].join("\n"),
      [`${root}${sep}a.voyd`]: [
        "use src::b::B",
        "",
        "pub obj A {",
        "  peer: B",
        "}",
      ].join("\n"),
      [`${root}${sep}b.voyd`]: [
        "use src::a::A",
        "",
        "pub trait B",
        "  fn bounce(self, value: A) -> i32",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("supports cyclic imports when trait signatures use labeled parameters", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::hit::HitRecord",
        "",
        "pub fn main() -> i32",
        "  0",
      ].join("\n"),
      [`${root}${sep}hit.voyd`]: [
        "use src::material::Material",
        "",
        "pub obj HitRecord {",
        "  mat: Material",
        "}",
      ].join("\n"),
      [`${root}${sep}material.voyd`]: [
        "use src::hit::HitRecord",
        "",
        "pub trait Material",
        "  fn scatter({ rec: HitRecord }) -> bool",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("supports constructor calls imported through cyclic trait/object modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::hit::HitRecord",
        "",
        "pub fn main() -> i32",
        "  HitRecord()",
        "  0",
      ].join("\n"),
      [`${root}${sep}hit.voyd`]: [
        "use src::material::{ Material, Lambertian }",
        "use src::color::Color",
        "",
        "pub obj HitRecord {",
        "  mat: Material",
        "}",
        "",
        "impl HitRecord",
        "  fn init()",
        "    HitRecord { mat: Lambertian(Color()) }",
      ].join("\n"),
      [`${root}${sep}material.voyd`]: [
        "use src::hit::HitRecord",
        "use src::color::Color",
        "",
        "pub trait Material",
        "  fn scatter(self, { rec: HitRecord }) -> bool",
        "",
        "pub obj Lambertian {",
        "  albedo: Color",
        "}",
        "",
        "impl Material for Lambertian",
        "  fn init(albedo: Color)",
        "    Lambertian { albedo }",
        "",
        "  fn scatter(self, { rec: HitRecord }) -> bool",
        "    true",
      ].join("\n"),
      [`${root}${sep}color.voyd`]: [
        "pub obj Color {",
        "  value: i32",
        "}",
        "",
        "impl Color",
        "  fn init()",
        "    Color { value: 0 }",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("supports constructor calls across 3-module cyclic SCCs", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::a::HitRecord",
        "",
        "pub fn main() -> i32",
        "  HitRecord()",
        "  0",
      ].join("\n"),
      [`${root}${sep}a.voyd`]: [
        "use src::b::{ Material, Lambertian }",
        "use src::color::Color",
        "",
        "pub obj HitRecord {",
        "  mat: Material",
        "}",
        "",
        "impl HitRecord",
        "  fn init()",
        "    HitRecord { mat: Lambertian(Color()) }",
      ].join("\n"),
      [`${root}${sep}b.voyd`]: [
        "use src::c::HitAlias",
        "use src::color::Color",
        "",
        "pub trait Material",
        "  fn scatter(self, { rec: HitAlias }) -> bool",
        "",
        "pub obj Lambertian {",
        "  albedo: Color",
        "}",
        "",
        "impl Material for Lambertian",
        "  fn init(albedo: Color)",
        "    Lambertian { albedo }",
        "",
        "  fn scatter(self, { rec: HitAlias }) -> bool",
        "    true",
      ].join("\n"),
      [`${root}${sep}c.voyd`]: [
        "use src::a::HitRecord",
        "",
        "pub type HitAlias = HitRecord",
      ].join("\n"),
      [`${root}${sep}color.voyd`]: [
        "pub obj Color {",
        "  value: i32",
        "}",
        "",
        "impl Color",
        "  fn init()",
        "    Color { value: 0 }",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("retains cyclic semantics in recover mode without missing-module cascades", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::a::A",
        "",
        "pub fn main() -> i32",
        "  A()",
      ].join("\n"),
      [`${root}${sep}a.voyd`]: [
        "use src::b::B",
        "",
        "pub obj A {",
        "  peer: B",
        "}",
      ].join("\n"),
      [`${root}${sep}b.voyd`]: [
        "use src::a::A",
        "",
        "pub trait B",
        "  fn bad(self, a: A) -> i32",
        "",
        "pub fn boom() -> i32",
        "  missing()",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { diagnostics, semantics } = analyzeModules({
      graph,
      recoverFromTypingErrors: true,
    });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(semantics.has("src::a")).toBe(true);
    expect(semantics.has("src::b")).toBe(true);
    expect(combinedDiagnostics.some((diag) => diag.code === "TY0006")).toBe(true);
    expect(
      combinedDiagnostics.some(
        (diag) =>
          diag.code === "TY9999" &&
          /missing semantics for imported module/i.test(diag.message),
      ),
    ).toBe(false);
  });

  it("resolves std module imports without explicit self selectors", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]:
        "use std::msgpack\npub fn main() -> i32\n  msgpack::marker()",
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::msgpack",
      [`${stdRoot}${sep}msgpack.voyd`]: "pub fn marker() -> i32\n  1",
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");

    expect(mainSemantics?.binding.imports.map((imp) => imp.name)).toContain(
      "msgpack",
    );
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("resolves explicit std env/fs/path imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: [
        "pub use self::env",
        "pub use self::fs",
        "pub use self::path",
      ].join("\n"),
      [`${stdRoot}${sep}env.voyd`]: "pub fn get() -> i32\n  1",
      [`${stdRoot}${sep}fs.voyd`]: "pub fn exists() -> bool\n  true",
      [`${stdRoot}${sep}path.voyd`]: "pub obj Path {}",
      [`${srcRoot}${sep}main.voyd`]: [
        "use std::env::get",
        "use std::fs::exists",
        "use std::path::Path",
        "",
        "fn consume_path(_value: Path) -> i32",
        "  0",
        "",
        "pub fn main() -> i32",
        "  consume_path(Path {})",
        "  if exists() then: get() else: 0",
      ].join("\n"),
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");

    expect(mainSemantics?.binding.imports.map((imp) => imp.name)).toEqual(
      expect.arrayContaining(["get", "exists", "Path"]),
    );
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("rejects std::all alias hops to package-visible std internals", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::memory",
      [`${stdRoot}${sep}memory.voyd`]: `
pub fn hidden() -> i32
  1
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all
use memory::hidden

pub fn main() -> i32
  hidden()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(
      combinedDiagnostics.some(
        (diag) => diag.code === "BD0001" && diag.message.includes("hidden"),
      ),
    ).toBe(true);
  });

  it("allows explicit std submodule alias hops to package-visible members", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}memory.voyd`]: `
pub fn hidden() -> i32
  1
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::memory::self as memory
use memory::hidden

pub fn main() -> i32
  hidden()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("keeps std::all alias chains restricted to std::pkg-visible exports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::memory",
      [`${stdRoot}${sep}memory.voyd`]: `
pub fn hidden() -> i32
  1
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all
use memory::self as mem
use mem::hidden

pub fn main() -> i32
  hidden()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(
      combinedDiagnostics.some(
        (diag) => diag.code === "BD0001" && diag.message.includes("hidden"),
      ),
    ).toBe(true);
  });

  it("preserves explicit std-submodule permissions across module alias chains", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}memory.voyd`]: `
pub fn hidden() -> i32
  1
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::memory::self as memory
use memory::self as mem
use mem::hidden

pub fn main() -> i32
  hidden()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > 0) {
      throw new Error(
        JSON.stringify(
          combinedDiagnostics.map((diag) => ({
            code: diag.code,
            message: diag.message,
          })),
        ),
      );
    }
    expect(combinedDiagnostics).toHaveLength(0);
  });

  it("treats src imports as std-internal aliases when analyzing std modules", async () => {
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}msgpack.voyd`]:
        "use src::msgpack::fns::marker\npub fn top() -> i32\n  marker()",
      [`${stdRoot}${sep}msgpack${sep}fns.voyd`]:
        "use std::fixed_array::fns::hidden\npub fn marker() -> i32\n  hidden()",
      [`${stdRoot}${sep}fixed_array${sep}fns.voyd`]: "pub fn hidden() -> i32\n  1",
    });

    const graph = await loadModuleGraph({
      entryPath: `${stdRoot}${sep}msgpack.voyd`,
      roots: { src: stdRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(combinedDiagnostics).toHaveLength(0);
    expect(graph.modules.has("std::msgpack::fns")).toBe(true);
    expect(graph.modules.has("src::msgpack::fns")).toBe(false);
  });

  it("keeps std src aliases namespace-specific when pkg modules share segments", async () => {
    const stdRoot = resolve("/proj/std");
    const pkgDir = resolve("/proj/node_modules");
    const host = createMemoryHost({
      [`${stdRoot}${sep}msgpack.voyd`]: [
        "use pkg::foo::msgpack::fns::all",
        "use src::msgpack::fns::marker",
        "pub fn top() -> i32",
        "  marker()",
      ].join("\n"),
      [`${stdRoot}${sep}msgpack${sep}fns.voyd`]: "pub fn marker() -> i32\n  1",
      [`${pkgDir}${sep}foo${sep}src${sep}msgpack${sep}fns.voyd`]:
        "pub fn marker() -> i32\n  2",
    });

    const graph = await loadModuleGraph({
      entryPath: `${stdRoot}${sep}msgpack.voyd`,
      roots: { src: stdRoot, std: stdRoot, pkgDirs: [pkgDir] },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    const msgpackSemantics = semantics.get("std::msgpack");
    const msgpackUses = msgpackSemantics?.binding.uses.flatMap((decl) => decl.entries) ?? [];
    const localMarkerImport = msgpackUses.find(
      (entry) => entry.path.join("::") === "src::msgpack::fns::marker",
    );
    const externalMarkerImport = msgpackUses.find(
      (entry) => entry.path.join("::") === "pkg::foo::msgpack::fns",
    );

    expect(combinedDiagnostics).toHaveLength(0);
    expect(localMarkerImport?.moduleId).toBe("std::msgpack::fns");
    expect(externalMarkerImport?.moduleId).toBe("pkg:foo::msgpack::fns");
  });

  it("supports enum variant namespace imports through an imported type alias", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::enums::{ enum }",
      [`${stdRoot}${sep}enums.voyd`]: `
pub macro enum(enum_name, variants_block)
  let variants = variants_block.slice(1).map((variant) =>
    if is_list(variant) then:
      variant
    else:
      \`($variant {})
  )
  let variant_names = variants.map((variant) => variant.get(0))
  let object_decls = variants.map((variant) =>
    \`(obj $(variant.get(0)) $(variant.get(1)))
  )
  let first_variant = variant_names.get(0)
  let remaining_variants = variant_names.slice(1)
  let union_target = remaining_variants.reduce(
    first_variant,
    (acc, next) => \`($acc | $next)
  )
  let declarations = object_decls.push(\`(type ($enum_name = $union_target)))
  emit_many(declarations)
`,
      [`${srcRoot}${sep}drinks.voyd`]: `
use std::all

pub enum Drink
  Coffee { size: i32 }
  Tea { size: i32 }

impl Coffee
  pub fn init(size: i32) -> Coffee
    Coffee { size }

pub fn make() -> Drink
  Drink::Coffee(12)
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::drinks::{ Drink, make }
use Drink::Coffee

pub fn main() -> i32
  let drink: Drink = make()
  let coffee: Drink = Drink::Coffee(8)
  match(coffee)
    Coffee { size }:
      size
    Drink::Tea:
      0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(combinedDiagnostics).toHaveLength(0);
    expect(mainSemantics?.binding.imports.map((entry) => entry.name)).toContain("Coffee");
  });

  it("supports generic enum namespace single-member imports via use Drink::Coffee", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}drinks.voyd`]: `
pub obj Coffee<T> { size: T }
pub obj Tea<T> { size: T }
pub obj Water {}
pub type Drink<T> = Coffee<T> | Tea<T> | Water
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::drinks::{ Drink }
use Drink::Coffee

pub fn main() -> i32
  let drink: Drink<i32> = Coffee<i32> { size: 8 }
  match(drink)
    Coffee { size }:
      size
    Drink::Tea:
      0
    Drink::Water:
      0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(combinedDiagnostics).toHaveLength(0);
    expect(mainSemantics?.binding.imports.map((entry) => entry.name)).toContain("Coffee");
  });

  it("supports generic enum namespace grouped member imports", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}drinks.voyd`]: `
pub obj Coffee<T> { size: T }
pub obj Tea<T> { size: T }
pub obj Water {}
pub type Drink<T> = Coffee<T> | Tea<T> | Water
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::drinks::{ Drink }
use Drink::{ Coffee, Tea, Water }

pub fn main() -> i32
  let drink: Drink<i32> = Tea<i32> { size: 8 }
  match(drink)
    Coffee:
      0
    Tea { size }:
      size
    Water:
      0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    const importNames = new Set(
      mainSemantics?.binding.imports.map((entry) => entry.name) ?? [],
    );

    expect(combinedDiagnostics).toHaveLength(0);
    expect(importNames.has("Coffee")).toBe(true);
    expect(importNames.has("Tea")).toBe(true);
    expect(importNames.has("Water")).toBe(true);
  });

  it("allows redundant namespace imports for locally declared union members", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `
obj Apple {}
obj Banana { age: i32 }
type Fruit = Apple | Banana
type Produce = Fruit

use Fruit::{ Apple, Banana }
use Fruit::Apple
use Fruit::all
use Produce::{ Apple, Banana }
use Produce::Apple
use Produce::all

pub fn main() -> i32
  let fruit: Fruit = Banana(age: 7)
  match(fruit)
    Apple:
      0
    Banana { age }:
      age
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("imports qualified members from a locally declared union alias", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit

obj Banana {}
type Fruit = fruit::Apple | Banana

use Fruit::Apple

pub fn main() -> i32
  let _fruit: Fruit = Apple()
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("fieldwise-constructs module-qualified nominal types and aliases", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}models.voyd`]: `
pub obj Person { age: i32 }
pub obj Empty {}
pub type PersonAlias = Person
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::models

pub fn main() -> i32
  let person = models::Person(age: 5)
  let alias = models::PersonAlias(age: 6)
  let _empty = models::Empty()
  person.age + alias.age
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("imports members through imported union alias chains", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
pub obj Banana {}
pub type Fruit = Apple | Banana
pub type Produce = Fruit
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ Produce }
use Produce::{ Apple, Banana }

pub fn main() -> i32
  let _first: Produce = Apple()
  let _second: Produce = Banana()
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("preserves enum namespaces through alias-only re-exports", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
pub obj Banana {}
pub type Fruit = Apple | Banana
`,
      [`${srcRoot}${sep}api.voyd`]: `
pub use src::fruit::{ Fruit }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::api::{ Fruit }
use Fruit::Apple

pub fn main() -> i32
  let _apple: Fruit = Apple()
  let _banana: Fruit = Fruit::Banana()
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("preserves imported namespaces for qualified external union members", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}a.voyd`]: `
pub obj Apple {}
`,
      [`${srcRoot}${sep}b.voyd`]: `
pub obj Banana {}
`,
      [`${srcRoot}${sep}fruit.voyd`]: `
use src::{ a, b }
pub type Fruit = a::Apple | b::Banana
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ Fruit }
use Fruit::Apple

pub fn main() -> i32
  let _apple: Fruit = Apple()
  let _banana: Fruit = Fruit::Banana()
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("diagnoses ambiguous imported union namespace members", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}a.voyd`]: `
pub obj Item { a: i32 }
`,
      [`${srcRoot}${sep}b.voyd`]: `
pub obj Item { b: i32 }
`,
      [`${srcRoot}${sep}items.voyd`]: `
use src::{ a, b }
pub type Both = a::Item | b::Item
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::items::{ Both }
use Both::Item

pub fn main() -> i32
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics.some(
        (entry) =>
          entry.code === "BD0001" &&
          entry.message.includes("multiple distinct members named Item"),
      ),
      JSON.stringify(combinedDiagnostics),
    ).toBe(true);
  });

  it("diagnoses ambiguous same-named local union namespace members", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}a.voyd`]: `
pub obj Item { a: i32 }
`,
      [`${srcRoot}${sep}b.voyd`]: `
pub obj Item { b: i32 }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::{ a, b }

type Both = a::Item | b::Item
use Both::Item

pub fn main() -> i32
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics.some(
        (entry) =>
          entry.code === "BD0001" &&
          entry.message.includes("multiple distinct members named Item"),
      ),
      JSON.stringify(combinedDiagnostics),
    ).toBe(true);
  });

  it("deduplicates the same namespace member across re-export paths", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}origin.voyd`]: `
pub obj Item {}
`,
      [`${srcRoot}${sep}a.voyd`]: `
pub use src::origin::{ Item }
`,
      [`${srcRoot}${sep}b.voyd`]: `
pub use src::origin::{ Item }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::{ a, b }

type Both = a::Item | b::Item
use Both::Item

pub fn main() -> i32
  let _item: Both = Item()
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("infers fieldwise type arguments for imported nominal aliases", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}boxes.voyd`]: `
pub obj Box<T> { value: T }
pub type BoxAlias<T> = Box<T>
pub type BoxAliasChain<T> = BoxAlias<T>
pub obj Animal { id: i32 }
pub obj Dog: Animal { id: i32 }
pub obj AnimalBox<T: Animal> { value: T }
pub type AnimalBoxAlias<T: Animal> = AnimalBox<T>
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::boxes::{ AnimalBoxAlias, BoxAlias, BoxAliasChain, Dog }

pub fn main() -> i32
  let box = BoxAlias(value: 3)
  let chained = BoxAliasChain(value: 2)
  let constrained = AnimalBoxAlias(value: Dog(id: 4))
  box.value + chained.value + constrained.value.id
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("prefers qualified union members over same-named lexical types", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
pub type Fruit = Apple
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ Fruit }

obj Apple { value: i32 }

pub fn main() -> i32
  let first: Fruit = Fruit::Apple()
  let second: Fruit = Fruit::Apple {}
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("does not fieldwise-construct imported types with inaccessible init", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}guarded.voyd`]: `
pub obj Guarded { value: i32 }

impl Guarded
  pri fn init({ value: i32 }) -> Guarded
    Guarded { value: value + 1 }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::guarded::{ Guarded }

type GuardedAlias = Guarded

pub fn main() -> i32
  let guarded = Guarded(value: 1)
  let aliased = GuardedAlias(value: 2)
  guarded.value + aliased.value
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(combinedDiagnostics.some((entry) => entry.code === "TY0041")).toBe(
      true,
    );
    expect(
      Array.from(semantics.get("src::main")?.hir.expressions.values() ?? []).some(
        (expr) => expr.exprKind === "object-literal" && expr.literalKind === "nominal",
      ),
    ).toBe(false);
  });

  it("infers unqualified imported union members in match patterns", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
pub obj Banana { age: i32 }
pub type Fruit = Apple | Banana
pub type BananaAlias = Banana
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ BananaAlias, Fruit }

fn score(fruit: Fruit) -> i32
  match(fruit)
    Apple:
      0
    Banana { age }:
      age

pub fn main() -> i32
  score(BananaAlias(age: 7))
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(combinedDiagnostics, JSON.stringify(combinedDiagnostics)).toHaveLength(0);
  });

  it("does not infer inaccessible imported union members in match patterns", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}choice.voyd`]: `
obj Hidden {}
pub obj Visible {}
pub type Choice = Hidden | Visible
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::choice::{ Choice }

pub fn score(choice: Choice) -> i32
  match(choice)
    Hidden:
      0
    Visible:
      1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const allDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      allDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "TY0026" && diagnostic.message.includes("Hidden"),
      ),
      JSON.stringify(allDiagnostics),
    ).toBe(true);
  });

  it("prefers explicitly imported lexical types over contextual match members", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple { local: i32 }
pub type Fruit = Apple
`,
      [`${srcRoot}${sep}foreign.voyd`]: `
pub obj Apple { foreign: i32 }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ Fruit }
use src::foreign::{ Apple }

pub fn score(fruit: Fruit) -> i32
  match(fruit)
    Apple:
      1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const allDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      allDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "TY0002" &&
          diagnostic.message.includes("does not match discriminant"),
      ),
      JSON.stringify(allDiagnostics),
    ).toBe(true);
  });

  it("does not override lexical traits during contextual match lookup", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}fruit.voyd`]: `
pub obj Apple {}
pub obj Banana {}
pub type Fruit = Apple | Banana
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::fruit::{ Fruit }

trait Apple
  fn id(self) -> i32

pub fn score(fruit: Fruit) -> i32
  match(fruit)
    Apple:
      1
    Banana:
      2
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const allDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      allDiagnostics.some((diagnostic) => diagnostic.code === "TY0002"),
      JSON.stringify(allDiagnostics),
    ).toBe(true);
  });

  it("resolves explicitly imported aliases before contextual match lookup", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}choice.voyd`]: `
pub obj Some<T> { value: T }
pub type Renamed<T> = Some<T>
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::choice::{ Renamed }

pub fn score(choice: Renamed<i32>) -> i32
  match(choice)
    Renamed<i32> { value }:
      value
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("uses explicit type arguments for contextual same-head match patterns", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}choice.voyd`]: `
pub obj Some<T> { value: T }
pub type Choice = Some<i32> | Some<bool>
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::choice::{ Choice }

pub fn score(choice: Choice) -> i32
  match(choice)
    Some<i32> { value }:
      value
    Some<bool>:
      0

pub fn main() -> i32
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("supports generic enum namespace all imports via use Drink::all", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}drinks.voyd`]: `
pub obj Coffee<T> { size: T }
pub obj Tea<T> { size: T }
pub obj Water {}
pub type Drink<T> = Coffee<T> | Tea<T> | Water
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::drinks::{ Drink }
use Drink::all

pub fn main() -> i32
  let drink: Drink<i32> = Coffee<i32> { size: 8 }
  match(drink)
    Coffee { size }:
      size
    Tea:
      0
    Water:
      0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    const mainSemantics = semantics.get("src::main");
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    const importNames = new Set(
      mainSemantics?.binding.imports.map((entry) => entry.name) ?? [],
    );

    expect(combinedDiagnostics).toHaveLength(0);
    expect(importNames.has("Coffee")).toBe(true);
    expect(importNames.has("Tea")).toBe(true);
    expect(importNames.has("Water")).toBe(true);
  });

  it("allows explicit std submodule enum namespace member imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}drinks.voyd`]: `
pub obj Coffee { size: i32 }
pub type Drink = Coffee
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::drinks::{ Drink }

pub fn main() -> i32
  let drink: Drink = Drink::Coffee { size: 1 }
  1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(
      combinedDiagnostics.some(
        (diag) =>
          diag.code === "BD0001" &&
          diag.message.includes("not visible here"),
      ),
    ).toBe(false);
  });

  it("rejects std::all enum namespace member access to package-visible variants", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${stdRoot}${sep}pkg.voyd`]: "pub use std::drinks::{ Drink }",
      [`${stdRoot}${sep}drinks.voyd`]: `
pub obj Coffee { size: i32 }
pub type Drink = Coffee
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let drink: Drink = Drink::Coffee { size: 1 }
  1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    expect(combinedDiagnostics.length).toBeGreaterThan(0);
  });

  it("does not auto-import package-visible enum variants across package boundaries", async () => {
    const srcRoot = resolve("/proj/src");
    const pkgDir = resolve("/proj/node_modules");
    const host = createMemoryHost({
      [`${pkgDir}${sep}bev${sep}src${sep}drinks.voyd`]: `
obj Coffee {}

pub type Drink = Coffee
`,
      [`${srcRoot}${sep}main.voyd`]: `
use pkg::bev::drinks::{ Drink }

pub fn main() -> Drink
  Drink::Coffee {}
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, pkgDirs: [pkgDir] },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(
      combinedDiagnostics.some(
        (diag) =>
          diag.code === "BD0001" &&
          diag.message.includes("not visible here"),
      ),
    ).toBe(true);
  });

  it("resolves public external members through imported union namespaces", async () => {
    const srcRoot = resolve("/proj/src");
    const host = createMemoryHost({
      [`${srcRoot}${sep}variants.voyd`]: `
pub obj Coffee {}
pub obj Tea {}
`,
      [`${srcRoot}${sep}drinks.voyd`]: `
use src::variants::all

pub type Drink = Coffee | Tea
`,
      [`${srcRoot}${sep}main.voyd`]: `
use src::drinks::{ Drink }

pub fn main() -> Drink
  Drink::Tea {}
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(
      combinedDiagnostics,
      JSON.stringify(combinedDiagnostics),
    ).toHaveLength(0);
  });

  it("deduplicates repeated grouped-import diagnostics with the same source span", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `
use std::{ array, array, array }

pub fn main() -> i32
  1
`,
      [`${stdRoot}${sep}pkg.voyd`]: `
pub fn marker() -> i32
  1
`,
      [`${stdRoot}${sep}prelude.voyd`]: `
pub fn keep_parser_happy() -> i32
  0
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];
    const repeated = combinedDiagnostics.filter(
      (diag) =>
        diag.code === "BD0001" &&
        diag.message.includes("std::pkg does not export array"),
    );

    expect(repeated).toHaveLength(1);
  });

  it("does not expose raw constructors from std root exports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `
use std::{ new_string }

pub fn main() -> i32
  1
`,
      [`${stdRoot}${sep}pkg.voyd`]: `
pub self::string
`,
      [`${stdRoot}${sep}prelude.voyd`]: `
pub fn keep_parser_happy() -> i32
  0
`,
      [`${stdRoot}${sep}string.voyd`]: `
pub fn new_string(_from_bytes: FixedArray<i32>) -> i32
  1
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    const combinedDiagnostics = [...graph.diagnostics, ...diagnostics];

    expect(
      combinedDiagnostics.some(
        (diag) =>
          diag.code === "BD0001" &&
          diag.message.includes("std::pkg does not export new_string"),
      ),
    ).toBe(true);
  });
});
