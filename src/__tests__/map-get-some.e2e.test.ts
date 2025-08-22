import { mapGetSomeVoyd } from "./fixtures/map-get-some.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E Map.get returns Some", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapGetSomeVoyd);
    instance = getWasmInstance(mod);
  });

  test("run returns stored value", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(1);
  });
});
