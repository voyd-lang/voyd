import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgram, type CompileProgramResult } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result;
};

const compileStdArrayFixture = async (): Promise<Uint8Array> => {
  const entryPath = resolve(fixtureRoot, "std_array_smoke.voyd");
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

describe("std::array compile smoke", () => {
  it("compiles std::array helpers with wasm validation", async () => {
    const wasm = await compileStdArrayFixture();
    expect(wasm.byteLength).toBeGreaterThan(0);
  });
});
