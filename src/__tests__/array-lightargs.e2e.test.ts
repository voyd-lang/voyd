import { describe, test, beforeAll, afterAll } from "vitest";
import assert from "node:assert";
import { htmlJsonVoyd } from "./fixtures/html-json.js";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array lightargs (gated default-on)", () => {
  let instance: WebAssembly.Instance;
  const prev = process.env.VOYD_ARRAY_LIGHTARGS;

  beforeAll(async () => {
    // Explicitly set to on (default is on as well)
    process.env.VOYD_ARRAY_LIGHTARGS = "1";
    const mod = await compile(htmlJsonVoyd);
    instance = getWasmInstance(mod);
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.VOYD_ARRAY_LIGHTARGS;
    else process.env.VOYD_ARRAY_LIGHTARGS = prev;
  });

  const expecteds = [5, 5, 33];

  for (let i = 0; i < expecteds.length; i++) {
    test(`html-json-lightargs test${i + 1}`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }
});

