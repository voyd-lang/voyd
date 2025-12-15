import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { getWasmInstanceWithFallback } from "../wasm.js";

const buildValidModule = (): binaryen.Module => {
  const mod = new binaryen.Module();
  mod.addFunction(
    "main",
    binaryen.none,
    binaryen.i32,
    [],
    mod.i32.const(7)
  );
  mod.addFunctionExport("main", "main");
  if (!mod.validate()) {
    throw new Error("expected binaryen module to validate");
  }
  return mod;
};

describe("wasm fallback", () => {
  it("uses fallback when preferred fails to compile", () => {
    const preferred = new Uint8Array([0x00, 0x01, 0x02]);
    const fallback = buildValidModule();
    const { instance, used } = getWasmInstanceWithFallback({ preferred, fallback });
    expect(used).toBe("fallback");
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("uses preferred when it compiles", () => {
    const preferred = buildValidModule();
    const fallback = buildValidModule();
    const { instance, used } = getWasmInstanceWithFallback({ preferred, fallback });
    expect(used).toBe("preferred");
    expect((instance.exports.main as () => number)()).toBe(7);
  });
});

