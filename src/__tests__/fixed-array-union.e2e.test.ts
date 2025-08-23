import { fixedArrayUnionVoyd } from "./fixtures/fixed-array-union.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("FixedArray unions with primitives", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(fixedArrayUnionVoyd);
    assert(mod.validate(), "Module is valid");
    instance = getWasmInstance(mod);
  });

  test("creates arrays of union types including primitives", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(2);
  });
});
