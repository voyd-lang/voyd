import { miniJsonArrayVoyd } from "./fixtures/mini-json-array.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E inline array arg type widening", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(miniJsonArrayVoyd);
    instance = getWasmInstance(mod);
  });

  test("run accepts array literal for Array<MiniJson>", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(1);
  });
});
