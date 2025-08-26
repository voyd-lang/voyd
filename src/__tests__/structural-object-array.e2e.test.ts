import { structuralObjectArrayVoyd } from "./fixtures/structural-object-array.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E structural object array", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(structuralObjectArrayVoyd);
    instance = getWasmInstance(mod);
  });

  test("structural object array literal executes without error", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(() => fn()).not.toThrow();
  });
});
