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
  });

  it("traps optimized direct at access when out of bounds", async () => {
    const result = await compileStdArrayFixture({
      optimize: true,
      boundaryExports: false,
    });
    const host = await createVoydHost({ wasm: result.wasm });
    await expect(host.run<number>("direct_at_out_of_bounds")).rejects.toThrow();
  });

  it("lowers optimized direct len/at access without dynamic dispatch", async () => {
    const result = await compileStdArrayFixture({
      optimize: true,
      boundaryExports: false,
    });
    const wat = result.module.emitText();
    const exportMatch = wat.match(/\(export "direct_len_at_sum" \(func \$(\d+)\)\)/);
    expect(exportMatch).not.toBeNull();
    const functionWat = extractWatFunction(wat, exportMatch?.[1] ?? "");

    expect(functionWat).toContain("struct.get");
    expect(functionWat).toContain("array.get");
    expect(functionWat).not.toContain("call_ref");
  });
});
