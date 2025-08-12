import { labeledParamsVoyd } from "./fixtures/labeled-params.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E labeled parameters", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(labeledParamsVoyd);
    instance = getWasmInstance(mod);
  });

  test("function with normal labels runs", (t) => {
    const fn = getWasmFn("normal_labels", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "normal_labels returns correct value").toEqual(3);
  });

  test("function mixing normal and external labels runs", (t) => {
    const fn = getWasmFn("mixed_labels", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "mixed_labels returns correct value").toEqual(7);
  });
});
