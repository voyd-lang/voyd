import { arrayFuncsVoyd } from "./fixtures/array-funcs.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array functional helpers (map/filter/reduce/find/some/every/each)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arrayFuncsVoyd);
    instance = getWasmInstance(mod);
  });

  const expecteds = [14, 6, 6, 2, 3, 1, 0];

  for (let i = 0; i < expecteds.length; i++) {
    test(`test${i + 1} returns expected`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});
