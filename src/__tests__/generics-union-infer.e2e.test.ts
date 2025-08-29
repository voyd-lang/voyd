import { genericsUnionInferVoyd } from "./fixtures/generics-union-infer.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E union generic inference", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericsUnionInferVoyd);
    instance = getWasmInstance(mod);
  });

  test("infers T from (Array<T> | String) given (Array<i32> | String)", (t) => {
    const fn = getWasmFn("test1", instance);
    assert(fn, "test1 exists");
    t.expect(fn()).toEqual(7);
  });
});

