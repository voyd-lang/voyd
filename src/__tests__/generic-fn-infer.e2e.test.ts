import { genericFnInferVoyd } from "./fixtures/generic-fn-infer.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E generic fn type inference", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericFnInferVoyd);
    instance = getWasmInstance(mod);
  });

  test("run returns sum", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns sum").toEqual(3);
  });
});
