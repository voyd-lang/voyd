import { mapInitInferVoyd } from "./fixtures/map-init-infer.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("map init infers type", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapInitInferVoyd);
    instance = getWasmInstance(mod);
  });

  test("main returns expected", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "main exists");
    t.expect(fn()).toEqual(1);
  });
});
