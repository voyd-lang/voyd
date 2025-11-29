import { mapsIteratorsVoyd } from "./fixtures/maps-iterators.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@voyd/lib/wasm.js";

describe("E2E maps and iterators (grouped)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapsIteratorsVoyd);
    instance = getWasmInstance(mod);
  });

  const expecteds = [3, 195, 1];

  for (let i = 0; i < expecteds.length; i++) {
    test(`test${i + 1} returns expected`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});

