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
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
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
    expect([...graph.diagnostics, ...diagnostics]).toHaveLength(0);
  });

  it("treats src imports as std-internal aliases when analyzing std modules", async () => {
    const srcRoot = resolve("/proj/src");
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
    Tea:
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

  it("reports missing exports for unresolved enum namespace members", async () => {
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
      combinedDiagnostics.some(
        (diag) =>
          diag.code === "BD0001" &&
          diag.message.includes("src::drinks") &&
          diag.message.includes("Tea"),
      ),
    ).toBe(true);
  });
});
