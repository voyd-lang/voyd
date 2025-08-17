import { arrayFieldAccessVoyd } from "./fixtures/array-field-access.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E array field access", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(arrayFieldAccessVoyd);
    instance = getWasmInstance(mod);
  });

  test("run returns correct value", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(1);
  });
});
