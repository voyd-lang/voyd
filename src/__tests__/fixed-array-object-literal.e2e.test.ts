import { fixedArrayObjectLiteralVoyd } from "./fixtures/fixed-array-object-literal.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E fixed array from object literal", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(fixedArrayObjectLiteralVoyd);
    instance = getWasmInstance(mod);
  });

  test("run creates arrays from object literals", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(1);
  });
});

