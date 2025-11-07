import { arraysVoyd } from "./fixtures/arrays.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E arrays (grouped)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arraysVoyd);
    instance = getWasmInstance(mod);
  });

  const expecteds = [1, 1, 1, 42, 1, 1];

  for (let i = 0; i < expecteds.length; i++) {
    test(`test${i + 1} returns expected`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});

