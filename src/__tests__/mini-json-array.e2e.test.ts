import { miniJsonArrayVoyd } from "./fixtures/mini-json-array.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E recursive array arg type widening", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(miniJsonArrayVoyd);
    instance = getWasmInstance(mod);
  });

  test("main accepts nested array literal for Array<MiniJson>", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(10);
  });
});
