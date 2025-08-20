import { closureCallsClosureVoyd } from "./fixtures/closure-calls-closure.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closure invoking closure", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(closureCallsClosureVoyd);
    instance = getWasmInstance(mod);
  });

  test("closures can call other closures", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns updated value").toEqual(4);
  });
});
