import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("functional macros across modules", () => {
  it("expands pub macros from sibling modules", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

pub fn main() -> f64
  inc(2.0)
`,
      [macrosPath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("expands pub macros from pkg modules", async () => {
    const appRoot = resolve("/proj/app");
    const pkgRoot = resolve("/proj/pkg");
    const mainPath = `${appRoot}${sep}main.voyd`;
    const pkgPath = `${pkgRoot}${sep}macro_lib${sep}pkg.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use pkg::macro_lib::all

pub fn main() -> f64
  add_two(5.0)
`,
      [pkgPath]: `
pub macro add_two(value)
  syntax_template (+ $value 2.0)
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: pkgRoot },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("re-exports pub macros via pub use", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const basePath = `${root}${sep}base_macros.voyd`;
    const reexportPath = `${root}${sep}macro_exports.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macro_exports::all

pub fn main() -> f64
  inc(2.0)
`,
      [basePath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
      [reexportPath]: `
pub use src::base_macros::all
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("re-exports pub macros via bare pub module-expression", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const basePath = `${root}${sep}base_macros.voyd`;
    const reexportPath = `${root}${sep}macro_exports.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macro_exports::all

pub fn main() -> f64
  inc(2.0)
`,
      [basePath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
      [reexportPath]: `
pub src::base_macros::all
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("preserves inline pkg scope when re-exporting macros from nested pkg.voyd", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const nestedPkgPath = `${root}${sep}pkgs${sep}arith${sep}pkg.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::pkgs::arith::pkg::all

pub fn main() -> f64
  add_one(41.0)
`,
      [nestedPkgPath]: `
mod macros
  pub macro add_one(value)
    syntax_template (+ $value 1.0)

pub use self::macros::all
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("re-expands modules after generated imports load macros", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro import_generated_macros()
  syntax_template (use src::generated_macros::all)

import_generated_macros()
declare_helper()

pub fn main() -> f64
  helper()
`,
      [macrosPath]: `
pub macro declare_helper()
  syntax_template (fn helper() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("re-expands importers when generated re-exports add macros", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const brokerPath = `${root}${sep}broker.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::broker::all

declare_helper()

pub fn main() -> f64
  helper()
`,
      [brokerPath]: `
macro import_generated_macros()
  syntax_template (pub use src::generated_macros::all)

import_generated_macros()
`,
      [macrosPath]: `
pub macro declare_helper()
  syntax_template (fn helper() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("rebuilds exported macro scopes after generated imports load", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const brokerPath = `${root}${sep}broker.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::broker::all

declare_helper()

pub fn main() -> f64
  helper()
`,
      [brokerPath]: `
macro import_generated_macros()
  syntax_template (use src::generated_macros::all)

import_generated_macros()

pub macro declare_helper()
  answer()
`,
      [macrosPath]: `
pub macro answer()
  syntax_template (fn helper() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("resolves generated pkg self uses against generated inline modules", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const pkgPath = `${root}${sep}pkgs${sep}arith${sep}pkg.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::pkgs::arith::pkg::all

declare_helper()

pub fn main() -> f64
  helper()
`,
      [pkgPath]: `
macro declare_macros_module()
  emit_many(
    \`(mod macros (block (pub use src::generated_macros::all))),
    \`(pub use self::macros::all)
  )

declare_macros_module()
`,
      [macrosPath]: `
pub macro declare_helper()
  syntax_template (fn helper() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("preserves literal numeric types when splicing macro arguments", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
obj Some {
  value: i32
}

obj None {}

type Optional = Some | None

fn some(v: i32): () -> Optional
  Some { value: v }

pub macro '??'(l, r)
  let item = identifier(__item)
  \`
    let $item = $l
    if $item is Some:
      $item.value
    else:
      $r

pub fn main() -> i32
  some(5) ?? 0
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });
});
