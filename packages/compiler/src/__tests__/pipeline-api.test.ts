import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import {
  analyzeModules,
  compileProgram,
  type CompileProgramResult,
  loadModuleGraph,
  lowerProgram,
} from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";

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
  it("compiles a program from the module graph through codegen", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    }));
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

    const result = expectCompileFailure(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((diag) => diag.code === "CG0003")).toBe(
      true
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

    const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "TY0034");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.span.file).toBe(mainPath);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "TY9999")).toBe(false);
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

  it("reports missing nominal object fields as typing diagnostics", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj A { x: i32 }
pub obj B { a: i32, b: i32 }

pub fn new_array<T>({ from source: FixedArray<T> }) -> FixedArray<T>
  source

pub fn main() -> voyd
  let a = [A { x: 1 }]
  let a = [B { a: 1 }]
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

    const result = expectCompileSuccess(await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    }));
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

    const result = expectCompileSuccess(await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    }));
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

    const result = expectCompileSuccess(await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    }));
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

    const result = expectCompileFailure(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true
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

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: packagesRoot },
      host,
    }));
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

    const result = expectCompileFailure(await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: packagesRoot },
      host,
    }));
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true
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

    const result = expectCompileFailure(await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    }));
    expect(
      result.diagnostics.some(
        (diag) =>
          diag.code === "BD0001" &&
          diag.message.includes("instance member")
      )
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

    const result = expectCompileSuccess(await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(8);
  });
});
