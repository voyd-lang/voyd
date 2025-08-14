import { objectShorthandVoyd } from "./fixtures/object-literal-shorthand.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E object literal shorthand", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(objectShorthandVoyd);
    instance = getWasmInstance(mod);
  });

  test("object literal shorthand expands correctly", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(6);
  });
});

