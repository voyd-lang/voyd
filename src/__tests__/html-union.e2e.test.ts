import { htmlUnionVoyd } from "./fixtures/html-union.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E html union match", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(htmlUnionVoyd);
    instance = getWasmInstance(mod);
  });

  test("main returns correct value", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(5);
  });
});
