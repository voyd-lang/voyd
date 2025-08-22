import { recursiveUnionVoyd } from "./fixtures/recursive-union.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E recursive unions", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(recursiveUnionVoyd);
    assert(mod.validate(), "Module is valid");
    instance = getWasmInstance(mod);
  });

  test("can find ints in recursive boxes", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(5);
  });
});
