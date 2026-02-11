import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { wasmBufferSource } from "../codegen/__tests__/support/wasm-utils.js";

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

const wasmExportNames = (wasm: Uint8Array | undefined): string[] => {
  if (!wasm) {
    return [];
  }
  const mod = new WebAssembly.Module(wasmBufferSource(wasm));
  return WebAssembly.Module.exports(mod)
    .map((entry) => entry.name)
    .sort();
};

describe("memory export ABI", () => {
  it("exports linear memory by default for no-std modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  1`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    const names = wasmExportNames(result.wasm);
    expect(names).toContain("main");
    expect(names).toContain("memory");
    expect(names).not.toContain("effects_memory");
  });

  it("does not pull std::pkg or effects_memory for explicit std::memory imports", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `use std::memory::self as memory

pub fn main() -> i32
  1`,
      [`${stdRoot}${sep}memory.voyd`]: `@intrinsic(name: "__memory_size")
pub fn size(): () -> i32
  __memory_size()`,
      [`${stdRoot}${sep}pkg.voyd`]: "pub use self::test::assertions::all",
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${srcRoot}${sep}main.voyd`,
        roots: { src: srcRoot, std: stdRoot },
        host,
      }),
    );

    const modules = Array.from(result.semantics?.keys() ?? []);
    expect(modules).toContain("std::memory");
    expect(modules).not.toContain("std::pkg");

    const names = wasmExportNames(result.wasm);
    expect(names).toContain("memory");
    expect(names).not.toContain("effects_memory");
  });

  it("exports effects_memory under auto for effectful modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `eff Ping
  fn ping(resume) -> i32

pub fn main() -> i32
  try
    Ping::ping()
  ping(resume):
    7`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
        codegenOptions: { effectsHostBoundary: "off" },
      }),
    );

    const names = wasmExportNames(result.wasm);
    expect(names).toContain("memory");
    expect(names).toContain("effects_memory");
  });
});
