import { mapInitVoyd } from "./fixtures/map-init.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("Map init", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapInitVoyd);
    instance = getWasmInstance(mod);
  });

  test("initializes from 2d array", (t) => {
    const fn = getWasmFn("map_from_pairs", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(1);
  });
});
