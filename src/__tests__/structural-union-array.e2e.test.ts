import { structuralUnionArrayVoyd } from "./fixtures/structural-union-array.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("arrays with union elements", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(structuralUnionArrayVoyd);
    assert(mod.validate(), "Module is valid");
    instance = getWasmInstance(mod);
  });

  test("compiles arrays containing unions", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(typeof fn).toBe("function");
  });
});

