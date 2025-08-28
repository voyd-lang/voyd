import { genericUnifyArrayPairTupleVoyd } from "./fixtures/generic-unify-array-pair-tuple.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E structural inference with tuple pairs", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericUnifyArrayPairTupleVoyd);
    instance = getWasmInstance(mod);
  });

  test("wrap infers T from Array<(String, i32)>", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns inferred element").toEqual(42);
  });
});
