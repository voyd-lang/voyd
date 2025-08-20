import { genericArrayReduceVoyd } from "./fixtures/generic-array-reduce.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E generic array reduce", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(genericArrayReduceVoyd);
    instance = getWasmInstance(mod);
  });

  test("run returns reduced sum", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns reduced sum").toEqual(6);
  });
});
