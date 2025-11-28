import { structuralInferenceVoyd } from "./fixtures/structural-inference.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@voyd/lib/wasm.js";

describe("E2E structural inference", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(structuralInferenceVoyd);
    instance = getWasmInstance(mod);
  });

  test("infers generic field type with extra object fields", (t) => {
    const fn = getWasmFn("test1", instance);
    assert(fn, "test1 exists");
    t.expect(fn()).toEqual(1);
  });
});
