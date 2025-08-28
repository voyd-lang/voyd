import { arrayTupleParamVoyd } from "./fixtures/array-tuple-param-nongeneric.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array of tuple param (non-generic)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arrayTupleParamVoyd);
    instance = getWasmInstance(mod);
  });

  test("runs without recursion", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns 42").toEqual(42);
  });
});

