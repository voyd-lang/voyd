import { arrayParamWidenVoyd } from "./fixtures/array-param-widen.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array param type widening", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arrayParamWidenVoyd);
    instance = getWasmInstance(mod);
  });

  test("main accepts inline array literal", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns 1").toEqual(1);
  });
});
