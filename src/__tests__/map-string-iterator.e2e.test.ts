import { mapStringIteratorVoyd } from "./fixtures/map-string-iterator.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E std iterators", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapStringIteratorVoyd);
    instance = getWasmInstance(mod);
  });

  test("map iterator sums values", (t) => {
    const fn = getWasmFn("map_iter_sum", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "map_iter_sum returns correct value").toEqual(3);
  });

  test("string iterator sums char codes", (t) => {
    const fn = getWasmFn("string_iter_sum", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "string_iter_sum returns correct value").toEqual(195);
  });
});
