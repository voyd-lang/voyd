import { genericTraitParamVoyd } from "./fixtures/generic-trait-param.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E generic trait object parameters", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericTraitParamVoyd);
    instance = getWasmInstance(mod);
  });

  test("run_a returns correct value", (t) => {
    const fn = getWasmFn("run_a", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run_a returns correct value").toEqual(4);
  });

  test("run_b returns correct value", (t) => {
    const fn = getWasmFn("run_b", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run_b returns correct value").toEqual(4);
  });
});
