import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { compileProgram } from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

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

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
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

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: pkgRoot },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
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

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });
});
