import { htmlJsonVoyd } from "./fixtures/html-json.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E HTML/JSON unions (grouped)", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(htmlJsonVoyd);
    instance = getWasmInstance(mod);
  });

  const expecteds = [5, 5, 33];

  for (let i = 0; i < expecteds.length; i++) {
    test(`test${i + 1} returns expected`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});

