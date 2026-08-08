import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import {
  analyzeModules,
  compileProgram,
  emitProgram,
  emitProgramWithContinuationFallback,
  type CompileProgramResult,
  loadModuleGraph,
  lowerProgram,
} from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result;
};

const expectCompileFailure = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: false }> => {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected compile failure");
  }
  return result;
};

describe("next pipeline API", () => {
  it("prepares optimized normal and continuation-fallback emission identically", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
fn folded() -> i32
  20 + 22

pub fn main() -> i32
  folded()
`,
    });
    const graph = await loadModuleGraph({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });
    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toEqual([]);
    const codegenOptions = { optimizationLevel: "release" } as const;

    const normal = await emitProgram({ graph, semantics, codegenOptions });
    const withFallback = await emitProgramWithContinuationFallback({
      graph,
      semantics,
      codegenOptions,
    });

    expect(withFallback.preferredWasm).toEqual(normal.wasm);
  });

  it("compiles a program from the module graph through codegen", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );
    expect(result.wasm?.length ?? 0).toBeGreaterThan(0);
    expect(result.semantics?.has("src::main")).toBe(true);
  });

  it("surfaces codegen diagnostics in pipeline results", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
pub fn identity<T>(value: T) -> T
  value

pub fn main()
  0
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((diag) => diag.code === "CG0003")).toBe(
      true,
    );
  });

  it("collects diagnostics from multiple modules instead of halting early", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::a::all
use src::b::all

pub fn main() -> i32
  0
`,
      [`${root}${sep}a.voyd`]: `
pub fn broken_a() -> i32
  missing_a
`,
      [`${root}${sep}b.voyd`]: `
pub fn broken_b() -> i32
  missing_b
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    const undefinedIdentifierDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TY0030",
    );

    expect(
      undefinedIdentifierDiagnostics.some((diagnostic) =>
        diagnostic.message.includes("missing_a"),
      ),
    ).toBe(true);
    expect(
      undefinedIdentifierDiagnostics.some((diagnostic) =>
        diagnostic.message.includes("missing_b"),
      ),
    ).toBe(true);
  });

  it("collects multiple undefined call diagnostics in the same function body", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub fn main() -> i32
  hey(2)
  hi(4)
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );

    const unknownFunctionDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TY0006",
    );
    expect(unknownFunctionDiagnostics.length).toBeGreaterThanOrEqual(2);
    expect(
      unknownFunctionDiagnostics.some((diagnostic) =>
        diagnostic.message.includes("function 'hey' is not defined"),
      ),
    ).toBe(true);
    expect(
      unknownFunctionDiagnostics.some((diagnostic) =>
        diagnostic.message.includes("function 'hi' is not defined"),
      ),
    ).toBe(true);
  });

  it("reports generic missing return annotations as typing diagnostics", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub fn identity<T>(value: T)
  value

pub fn main() -> i32
  0
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );

    const diagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TY0034",
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.span.file).toBe(mainPath);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "TY9999"),
    ).toBe(false);
  });

  it("retains semantics for modules with typing diagnostics when recovery is enabled", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub fn identity<T>(value: T)
  value

pub fn main() -> i32
  let counter = 1
  counter
`,
    });

    const graph = await loadModuleGraph({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({
      graph,
      recoverFromTypingErrors: true,
    });

    expect(semantics.has("src::main")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "TY0034")).toBe(
      true,
    );
  });

  it("reports unresolved overload calls as typing diagnostics when recovery is enabled", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub fn foo(value: String) -> i32
  1

pub fn foo(value: bool) -> i32
  2

pub fn main() -> i32
  foo(1)
`,
    });

    const graph = await loadModuleGraph({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({
      graph,
      recoverFromTypingErrors: true,
    });

    expect(semantics.has("src::main")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "TY0008")).toBe(
      true,
    );
    expect(diagnostics.some((diagnostic) => diagnostic.code === "TY9999")).toBe(
      false,
    );
  });

  it("reports missing nominal object fields as typing diagnostics", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj A { x: i32 }
pub obj B { a: i32, b: i32 }

pub fn new_array_unchecked<T>({ from source: FixedArray<T> }) -> FixedArray<T>
  source

pub fn main() -> voyd
  let a = [A { x: 1 }]
  let b = [B { a: 1 }]
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );

    expect(
      result.diagnostics.some(
        (diag) =>
          diag.code === "TY0037" &&
          diag.message.includes("missing required field 'b'"),
      ),
    ).toBe(true);
    expect(result.diagnostics.some((diag) => diag.code === "TY9999")).toBe(
      false,
    );
  });

  it("rejects spreads from union values that are not structurally enumerable", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj A { x: i32 }
pub obj B { y: i32 }

fn spread(v: A | B)
  { ...v }

pub fn main()
  spread(A { x: 1 })
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );

    expect(
      result.diagnostics.some(
        (diag) =>
          diag.code === "TY0027" &&
          diag.message.includes("expected 'structural object'"),
      ),
    ).toBe(true);
  });

  it("lowers nominal literals with spreads as object literals when constructors exist", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj Version { major: i32, minor: i32, patch: i32 }

impl Version
  pub fn init(major: i32, minor: i32, patch: i32) -> Version
    Version { major, minor, patch }

pub fn main() -> i32
  let base = Version { major: 1, minor: 2, patch: 3 }
  let copy = Version { ...base, patch: 4 }
  copy.patch
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm?.length ?? 0).toBeGreaterThan(0);
  });
  it("orders modules topologically for lowering", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });
    const { semantics } = analyzeModules({ graph });
    const { orderedModules, entry } = lowerProgram({ graph, semantics });

    expect(entry).toBe("src::main");
    expect(orderedModules).toEqual(["src::main"]);
  });

  it("exports only pkg.voyd public API entries to wasm", async () => {
    const root = resolve("/proj/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const apiPath = `${root}${sep}api.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::api::all

pub use src::api::public_fn
`,
      [apiPath]: `
pub fn public_fn(): () -> i32
  7

pub fn internal_fn(): () -> i32
  3
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: pkgPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports as Record<string, unknown>;

    expect(typeof exports.public_fn).toBe("function");
    expect((exports.public_fn as () => number)()).toBe(7);
    expect(exports.internal_fn).toBeUndefined();
  });

  it("treats pub use as both a local import and public export", async () => {
    const root = resolve("/proj/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const apiPath = `${root}${sep}api.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
pub use src::api::public_fn

pub fn main() -> i32
  public_fn()
`,
      [apiPath]: `
pub fn public_fn(): () -> i32
  11
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: pkgPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports as Record<string, unknown>;
    expect(typeof exports.public_fn).toBe("function");
    expect((exports.public_fn as () => number)()).toBe(11);
    expect((exports.main as () => number)()).toBe(11);
  });

  it("exports members via bare pub module-expression", async () => {
    const root = resolve("/proj/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const apiPath = `${root}${sep}api.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
pub src::api::public_fn

pub fn main() -> i32
  public_fn()
`,
      [apiPath]: `
pub fn public_fn(): () -> i32
  13
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: pkgPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports as Record<string, unknown>;
    expect(typeof exports.public_fn).toBe("function");
    expect((exports.public_fn as () => number)()).toBe(13);
    expect((exports.main as () => number)()).toBe(13);
  });

  it("rejects accessing pri fields outside their object", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj SecretBox {
  pri value: i32,
}

impl SecretBox
  pub fn reveal(self) -> i32
    self.value

pub fn leak(box: SecretBox) -> i32
  box.value
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true,
    );
  });

  it("exposes only api members to other packages", async () => {
    const appRoot = resolve("/proj/app");
    const packagesRoot = resolve("/proj/pkg");
    const depRoot = `${packagesRoot}${sep}dep`;
    const mainPath = `${appRoot}${sep}main.voyd`;
    const depPkgPath = `${depRoot}${sep}pkg.voyd`;
    const depExternalPath = `${depRoot}${sep}src${sep}external.voyd`;

    const host = createMemoryHost({
      [mainPath]: `
use pkg::dep::all

pub fn main() -> i32
  let ext = make_external()
  ext.visible + ext.expose()
`,
      [depPkgPath]: `
use src::external::all

pub use src::external::External
pub use src::external::make_external
`,
      [depExternalPath]: `
pub obj External {
  api visible: i32,
  hidden: i32,
  pri secret: i32,
}

impl External
  api fn expose(self) -> i32
    self.visible + self.hidden

  fn hidden_value(self) -> i32
    self.hidden

  pri fn secret_value(self) -> i32
    self.secret

pub fn make_external(): () -> External
  External { visible: 2, hidden: 3, secret: 5 }
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: appRoot, pkg: packagesRoot },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("blocks external access to non-api members", async () => {
    const appRoot = resolve("/proj/app");
    const packagesRoot = resolve("/proj/pkg");
    const depRoot = `${packagesRoot}${sep}dep`;
    const mainPath = `${appRoot}${sep}leak.voyd`;
    const depPkgPath = `${depRoot}${sep}pkg.voyd`;
    const depExternalPath = `${depRoot}${sep}src${sep}external.voyd`;

    const host = createMemoryHost({
      [mainPath]: `
use pkg::dep::all

pub fn leak_hidden() -> i32
  make_external().hidden
`,
      [depPkgPath]: `
use src::external::all

pub use src::external::External
pub use src::external::make_external
`,
      [depExternalPath]: `
pub obj External {
  api visible: i32,
  hidden: i32,
  pri secret: i32,
}

impl External
  api fn expose(self) -> i32
    self.visible + self.hidden

  fn hidden_value(self) -> i32
    self.hidden

  pri fn secret_value(self) -> i32
    self.secret

pub fn make_external(): () -> External
  External { visible: 2, hidden: 3, secret: 5 }
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: appRoot, pkg: packagesRoot },
        host,
      }),
    );
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true,
    );
  });

  it("preserves macro, overload, operator, and trait metadata through a nested package root", async () => {
    const root = resolve("/proj/nested-metadata");
    const mainPath = `${root}${sep}main.voyd`;
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const internalPath = `${root}${sep}feature${sep}internal.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::feature::all

declare_bonus(generated_bonus)

pub fn main() -> i32
  let sum = Number { value: 1 } + Number { value: 2 }
  generated_bonus() + sum.score() + choose(1) + choose(1.0)
`,
      [packageRootPath]: `
pub use self::internal::{ Number, Scored, choose, declare_bonus, '+' }
`,
      [internalPath]: `
pub macro declare_bonus(name)
  syntax_template (fn $name() -> i32
    10)

pub obj Number { api value: i32 }

pub trait Scored
  fn score(self) -> i32

pub fn '+'(left: Number, right: Number) -> Number
  Number { value: left.value + right.value }

impl Scored for Number
  api fn score(self) -> i32
    self.value

pub fn choose(_value: i32) -> i32
  20

pub fn choose(_value: f64) -> i32
  30
`,
    });

    const compiled = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });
    if (!compiled.success) {
      throw new Error(JSON.stringify(compiled.diagnostics, null, 2));
    }
    const result = expectCompileSuccess(compiled);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(63);
  });

  it("classifies module, package, macro, member, operator, and trait boundaries", async () => {
    const root = resolve("/proj/boundary-diagnostics");
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const internalPath = `${root}${sep}feature${sep}internal.voyd`;
    const supportPath = `${root}${sep}support.voyd`;
    const macroPath = `${root}${sep}macros.voyd`;
    const operatorsRootPath = `${root}${sep}operators${sep}pkg.voyd`;
    const operatorsInternalPath = `${root}${sep}operators${sep}internal.voyd`;
    const traitModelPath = `${root}${sep}trait_model.voyd`;
    const traitImplPath = `${root}${sep}trait_impl.voyd`;
    const files = {
      [packageRootPath]: `
pub use self::internal::{ ExportedBox, make_box }
`,
      [internalPath]: `
pub obj ExportedBox { hidden: i32 }

pub fn make_box() -> ExportedBox
  ExportedBox { hidden: 7 }

pub fn package_only() -> i32
  11

fn nested_module_only() -> i32
  12
`,
      [supportPath]: `
fn module_only() -> i32
  13
`,
      [macroPath]: `
macro private_macro()
  syntax_template (fn generated() -> i32
    17)
`,
      [operatorsRootPath]: `
pub use self::internal::{ BoundaryNumber, '+' }
`,
      [operatorsInternalPath]: `
pub val BoundaryNumber { api value: i32 }

pub fn '+'(left: BoundaryNumber, right: BoundaryNumber) -> BoundaryNumber
  BoundaryNumber { value: left.value + right.value }
`,
      [traitModelPath]: `
pub val TraitNumber { value: i32 }

pub trait Scored
  fn score(self) -> i32
`,
      [traitImplPath]: `
use src::trait_model::{ TraitNumber, Scored }
pub use src::trait_model::{ TraitNumber, Scored }

impl Scored for TraitNumber
  fn score(self) -> i32
    self.value

pub fn marker() -> i32
  0
`,
    };
    const cases = [
      {
        entry: `${root}${sep}module-private.voyd`,
        source: "use src::support::module_only\npub fn main() -> i32\n  module_only()",
        message: "module-private",
        details: [supportPath],
      },
      {
        entry: `${root}${sep}hidden-internal.voyd`,
        source:
          "use src::feature::internal::package_only\npub fn main() -> i32\n  package_only()",
        message: "hidden nested-package internals",
        details: ["src::feature", packageRootPath],
      },
      {
        entry: `${root}${sep}hidden-module-private.voyd`,
        source:
          "use src::feature::internal::nested_module_only\npub fn main() -> i32\n  nested_module_only()",
        message: "hidden nested-package internals",
        details: ["src::feature", packageRootPath],
      },
      {
        entry: `${root}${sep}private-macro.voyd`,
        source: "use src::macros::private_macro\npub fn main() -> i32\n  0",
        message: "Macro private_macro",
        details: ["Add pub"],
      },
      {
        entry: `${root}${sep}missing-api.voyd`,
        source:
          "use src::feature::{ ExportedBox, make_box }\npub fn main() -> i32\n  make_box().hidden",
        message: "requires api visibility",
        details: ["local:feature -> local"],
      },
      {
        entry: `${root}${sep}missing-operator-import.voyd`,
        source:
          "use src::operators::BoundaryNumber\npub fn main() -> i32\n  (BoundaryNumber { value: 1 } + BoundaryNumber { value: 2 }).value",
        message: "operator '+'",
        details: [operatorsRootPath],
      },
      {
        entry: `${root}${sep}missing-trait-impl-import.voyd`,
        source:
          "use src::trait_model::TraitNumber\nuse src::trait_impl\npub fn main() -> i32\n  TraitNumber { value: 1 }.score()",
        message: "trait implementation providing 'score'",
        details: [traitImplPath],
      },
    ];

    for (const testCase of cases) {
      const result = expectCompileFailure(
        await compileProgram({
          entryPath: testCase.entry,
          roots: { src: root },
          host: createMemoryHost({
            ...files,
            [testCase.entry]: testCase.source,
          }),
        }),
      );
      const matches = result.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes(testCase.message) &&
          testCase.details.every((detail) =>
            diagnostic.message.includes(detail),
          ),
      );
      if (!matches) {
        throw new Error(
          JSON.stringify(
            { testCase, diagnostics: result.diagnostics },
            null,
            2,
          ),
        );
      }
    }
  });

  it("keeps package-root instance members out of module all imports", async () => {
    const root = resolve("/proj/package-member-all");
    const mainPath = `${root}${sep}main.voyd`;
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::feature::all

pub fn main() -> i32
  make_box().score()
`,
      [packageRootPath]: `
pub obj Box { api value: i32 }

impl Box
  api fn score(self) -> i32
    self.value

pub fn make_box() -> Box
  Box { value: 42 }
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const importedNames =
      result.semantics
        ?.get("src::main")
        ?.binding.imports.map((entry) => entry.name) ?? [];

    expect(importedNames).toEqual(expect.arrayContaining(["Box", "make_box"]));
    expect(importedNames).not.toContain("score");
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("keeps same-named ordinary exports separate from instance projections", async () => {
    const root = resolve("/proj/package-member-collision");
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const packageSource = `
pub obj Box { api value: i32 }

impl Box
  api fn score(self) -> i32
    self.value

pub fn score(value: i32) -> i32
  value

pub fn make_box() -> Box
  Box { value: 42 }
`;
    const entrySources = [
      `use src::feature::all

pub fn main() -> i32
  score(1) + make_box().score()
`,
      `use src::feature::{ score, make_box }

pub fn main() -> i32
  score(1) + make_box().score()
`,
    ];

    for (const [index, source] of entrySources.entries()) {
      const mainPath = `${root}${sep}main_${index}.voyd`;
      const result = expectCompileSuccess(
        await compileProgram({
          entryPath: mainPath,
          roots: { src: root },
          host: createMemoryHost({
            [mainPath]: source,
            [packageRootPath]: packageSource,
          }),
        }),
      );
      const instance = getWasmInstance(result.wasm!);
      expect((instance.exports.main as () => number)()).toBe(43);
    }
  });

  it("keeps instance projections out of module-qualified calls", async () => {
    const root = resolve("/proj/package-qualified-member");
    const mainPath = `${root}${sep}main.voyd`;
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const result = expectCompileFailure(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host: createMemoryHost({
          [mainPath]: `
use src::feature

pub fn main() -> i32
  feature::score(feature::make_box())
`,
          [packageRootPath]: `
pub obj Box { api value: i32 }

impl Box
  api fn score(self) -> i32
    self.value

pub fn make_box() -> Box
  Box { value: 42 }
`,
        }),
      }),
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "BD0001",
          message: expect.stringContaining(
            "Box::score is an instance member and must be accessed through its type",
          ),
        }),
      ]),
    );
  });

  it("reports logical package-root misses without hiding declaration diagnostics", async () => {
    const root = resolve("/proj/logical-package-diagnostics");
    const packageRootPath = `${root}${sep}feature${sep}pkg.voyd`;
    const internalPath = `${root}${sep}feature${sep}internal.voyd`;
    const packageSource = `
pub use self::internal::public_one

fn root_private() -> i32
  3
`;
    const internalSource = `
pub fn public_one() -> i32
  1

pub fn package_only() -> i32
  2
`;
    const missingPath = `${root}${sep}missing.voyd`;
    const missing = expectCompileFailure(
      await compileProgram({
        entryPath: missingPath,
        roots: { src: root },
        host: createMemoryHost({
          [missingPath]: "use src::feature::package_only",
          [packageRootPath]: packageSource,
          [internalPath]: internalSource,
        }),
      }),
    );
    const missingDiagnostic = missing.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "BD0001" &&
        diagnostic.message.includes("package_only"),
    );
    expect(missingDiagnostic?.message).toContain(
      "Module src::feature does not export package_only",
    );
    expect(missingDiagnostic?.message).toContain(packageRootPath);
    expect(missingDiagnostic?.message).toContain("re-export it");
    expect(missingDiagnostic?.message).not.toContain("src::feature::pkg");

    const privatePath = `${root}${sep}private.voyd`;
    const privateResult = expectCompileFailure(
      await compileProgram({
        entryPath: privatePath,
        roots: { src: root },
        host: createMemoryHost({
          [privatePath]: "use src::feature::root_private",
          [packageRootPath]: packageSource,
          [internalPath]: internalSource,
        }),
      }),
    );
    expect(privateResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "BD0001",
          message: expect.stringContaining(
            `root_private from src::feature::pkg: it is module-private in ${packageRootPath}`,
          ),
        }),
      ]),
    );
  });

  it("rejects pub re-export of instance methods", async () => {
    const root = resolve("/proj/reexport");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const externalPath = `${root}${sep}external.voyd`;

    const host = createMemoryHost({
      [pkgPath]: `
pub use src::external::External
pub use src::external::expose

pub fn main() -> i32
  0
`,
      [externalPath]: `
pub obj External { api value: i32 }

impl External
  api fn expose(self) -> i32
    self.value

pub fn make_external(): () -> External
  External { value: 1 }
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath: pkgPath,
        roots: { src: root },
        host,
      }),
    );
    expect(
      result.diagnostics.some(
        (diag) =>
          diag.code === "BD0001" && diag.message.includes("instance member"),
      ),
    ).toBe(true);
  });

  it("allows importing static methods", async () => {
    const root = resolve("/proj/static");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const counterPath = `${root}${sep}counter.voyd`;

    const host = createMemoryHost({
      [pkgPath]: `
use src::counter::all

pub use src::counter::new

pub fn main(): () -> i32
  let counter = new(4)
  counter.double()
`,
      [counterPath]: `
pub obj Counter { api value: i32 }

impl Counter
  fn new(value: i32): () -> Counter
    Counter { value }

  api fn double(self) -> i32
    self.value * 2
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: pkgPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(8);
  });
});
