import {
  closureParamInferOneVoyd,
  closureParamInferTwoVoyd,
} from "./fixtures/closure-param-infer.js";
import { closureParamInferLabeledVoyd } from "./fixtures/closure-param-infer-labeled.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closure parameter inference", () => {
  test("infers single parameter closure", async (t) => {
    const mod = await compile(closureParamInferOneVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(10);
  });

  test("infers two parameter closure", async (t) => {
    const mod = await compile(closureParamInferTwoVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(7);
  });

  test("infers labeled closure parameters", async (t) => {
    const mod = await compile(closureParamInferLabeledVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(6);
  });
});
