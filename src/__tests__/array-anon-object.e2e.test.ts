import { arrayAnonObjectVoyd } from "./fixtures/array-anon-object.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array with anonymous object literal", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arrayAnonObjectVoyd);
    instance = getWasmInstance(mod);
  });

  test("run executes without illegal cast", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(1);
  });
});
