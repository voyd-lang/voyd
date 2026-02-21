import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgram, type CompileProgramResult } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";
import { createEffectsImports } from "./support/wasm-imports.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");

const expectCompileSuccess = (
  result: CompileProgramResult
): Extract<CompileProgramResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result;
};

const compileSubscriptFixture = async (): Promise<Uint8Array> => {
  const entryPath = resolve(fixtureRoot, "subscript_smoke.voyd");
  const result = expectCompileSuccess(await compileProgram({
    entryPath,
    roots: { src: fixtureRoot, std: stdRoot },
    host: createFsModuleHost(),
    codegenOptions: { validate: true },
  }));
  if (!result.wasm) {
    throw new Error("missing wasm output");
  }
  return result.wasm;
};

const instantiate = (wasm: Uint8Array): WebAssembly.Instance =>
  new WebAssembly.Instance(
    new WebAssembly.Module(wasmBufferSource(wasm)),
    createEffectsImports()
  );

describe("subscript smoke e2e", () => {
  it("executes index, range, and map subscripts", async () => {
    const wasm = await compileSubscriptFixture();
    const instance = instantiate(wasm);
    const exports = instance.exports as Record<string, CallableFunction>;

    expect((exports.read_index as () => number)()).toBe(20);
    expect((exports.write_index as () => number)()).toBe(99);
    expect((exports.slice_exclusive as () => number)()).toBe(5);
    expect((exports.slice_inclusive as () => number)()).toBe(5);
    expect((exports.slice_left_unbounded as () => number)()).toBe(3);
    expect((exports.slice_left_unbounded_inclusive as () => number)()).toBe(3);
    expect((exports.slice_right_unbounded as () => number)()).toBe(7);
    expect((exports.slice_full_unbounded as () => number)()).toBe(4);
    expect((exports.map_roundtrip as () => number)()).toBe(7);
  });

  it("traps on out-of-bounds direct subscript assignment", async () => {
    const wasm = await compileSubscriptFixture();
    const instance = instantiate(wasm);
    const exports = instance.exports as Record<string, CallableFunction>;
    expect(() => (exports.write_oob as () => number)()).toThrow(
      /unreachable|runtime|out of bounds/i
    );
  });
});
