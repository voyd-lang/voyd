import { genericUnifyArrayPairVoyd } from "./fixtures/generic-unify-array-pair.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E structural generic inference", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericUnifyArrayPairVoyd);
    instance = getWasmInstance(mod);
  });

  test("infers T from Array<T> parameter", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns inferred element").toEqual(42);
  });
});
