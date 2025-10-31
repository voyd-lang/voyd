import { linearMemoryGroupVoyd } from "./fixtures/linear-memory-group.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E linear memory (grouped)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(linearMemoryGroupVoyd);
    instance = getWasmInstance(mod);
  });

  // Ensure memory size check runs before any growth side-effects.
  const order = [3, 1, 2] as const;
  const expecteds = [0, 42, 42];

  for (let i = 0; i < order.length; i++) {
    const testId = order[i];
    test(`test${testId} returns expected`, (t) => {
      const fn = getWasmFn(`test${testId}`, instance);
      assert(fn, `test${testId} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});
