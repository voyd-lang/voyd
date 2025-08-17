import { closureParamVoyd } from "./fixtures/closure-params.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closure parameters", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(closureParamVoyd);
    instance = getWasmInstance(mod);
  });

  test("closures can be passed as parameters", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(10);
  });
});
