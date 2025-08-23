import { miniJsonVoyd } from "./fixtures/mini-json.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe.skip("E2E MiniJson generic resolution", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(miniJsonVoyd);
    assert(mod.validate(), "Module is valid");
    instance = getWasmInstance(mod);
  });

  test("accepts array of strings for MiniJson parameter", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(1);
  });
});
