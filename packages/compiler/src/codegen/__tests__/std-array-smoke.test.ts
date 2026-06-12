import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVoydHost } from "@voyd-lang/js-host";
import type { CodegenOptions } from "../context.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const fixturePath = resolve(fixtureRoot, "std_array_smoke.voyd");

const extractWatFunction = (wat: string, functionId: string): string => {
  const start = wat.indexOf(`(func $${functionId} `);
  expect(start).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = start; index < wat.length; index += 1) {
    const char = wat[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0) {
      return wat.slice(start, index + 1);
    }
  }

  throw new Error(`unterminated function $${functionId}`);
};

const compileStdArrayFixture = async (
  codegenOptions: CodegenOptions = {},
) =>
  compileEffectFixture({
    entryPath: fixturePath,
    codegenOptions: {
      validate: true,
      effectsHostBoundary: "off",
      ...codegenOptions,
    },
  });

const watForExport = (wat: string, exportName: string): string => {
  const exportMatch = wat.match(
    new RegExp(`\\(export "${exportName}" \\(func \\$([^\\s\\)]+)\\)\\)`),
  );
  expect(exportMatch).not.toBeNull();
  return extractWatFunction(wat, exportMatch?.[1] ?? "");
};

describe("std::array compile smoke", () => {
  it("compiles std::array helpers with wasm validation", async () => {
    const result = await compileStdArrayFixture();
    expect(result.wasm.byteLength).toBeGreaterThan(0);
  });

  it("runs optimized direct len/at access", async () => {
    const result = await compileStdArrayFixture({
      optimize: true,
      boundaryExports: false,
    });
    const host = await createVoydHost({ wasm: result.wasm });
    await expect(host.run<number>("direct_len_at_sum")).resolves.toBe(43);
    await expect(host.run<number>("direct_value_len_at_sum")).resolves.toBe(20);
    await expect(host.run<number>("direct_at_index_side_effect")).resolves.toBe(20);
    await expect(host.run<number>("safe_while_sum")).resolves.toBe(10);
    await expect(host.run<number>("safe_while_cached_len_sum")).resolves.toBe(10);
    await expect(host.run<number>("safe_while_value_sum")).resolves.toBe(18);
    await expect(host.run<number>("safe_for_sum")).resolves.toBe(10);
    await expect(host.run<number>("while_non_zero_start_sum")).resolves.toBe(9);
    await expect(host.run<number>("while_non_unit_step_sum")).resolves.toBe(4);
    await expect(host.run<number>("while_unknown_bound_sum")).resolves.toBe(3);
    await expect(host.run<number>("while_mutates_array_sum")).resolves.toBe(3);
    await expect(host.run<number>("while_alias_mutation_sum")).resolves.toBe(3);
    await expect(host.run<number>("while_stale_length_sum")).resolves.toBe(3);
  });

  it("traps optimized direct at access when out of bounds", async () => {
    const result = await compileStdArrayFixture({
      optimize: true,
      boundaryExports: false,
    });
    const host = await createVoydHost({ wasm: result.wasm });
    await expect(host.run<number>("direct_at_out_of_bounds")).rejects.toThrow();
    await expect(
      host.run<number>("while_increment_before_at_trap"),
    ).rejects.toThrow();
    await expect(
      host.run<number>("while_captured_call_mutation_trap"),
    ).rejects.toThrow();
  });

  it("lowers optimized direct len/at access without dynamic dispatch", async () => {
    const result = await compileStdArrayFixture({
      boundaryExports: false,
    });
    const wat = result.module.emitText();
    const functionWat = watForExport(wat, "direct_len_at_sum");

    expect(functionWat).toContain("struct.get");
    expect(functionWat).toContain("array.get");
    expect(functionWat).not.toContain("call_ref");
  });

  it("elides loop-proven Array.at checks in safe counted loops", async () => {
    const result = await compileStdArrayFixture({
      boundaryExports: false,
    });
    const wat = result.module.emitText();

    for (const exportName of [
      "safe_while_sum",
      "safe_while_cached_len_sum",
      "safe_while_value_sum",
      "safe_for_sum",
    ]) {
      const functionWat = watForExport(wat, exportName);
      expect(functionWat).toContain("array.get");
      expect(functionWat).not.toContain("unreachable");
      expect(functionWat).not.toContain("call_ref");
      expect(functionWat).not.toContain("call_indirect");
    }
  });

  it("keeps Array.at checks when loop safety proof is invalid", async () => {
    const result = await compileStdArrayFixture({
      boundaryExports: false,
    });
    const wat = result.module.emitText();

    for (const exportName of [
      "while_non_zero_start_sum",
      "while_non_unit_step_sum",
      "while_unknown_bound_sum",
      "while_mutates_array_sum",
      "while_alias_mutation_sum",
      "while_stale_length_sum",
      "while_increment_before_at_trap",
      "while_captured_call_mutation_trap",
    ]) {
      const functionWat = watForExport(wat, exportName);
      expect(functionWat).toContain("array.get");
      expect(functionWat).toContain("unreachable");
    }
  });
});
