import { methodFnConflictVoyd } from "./fixtures/method-fn-conflict.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@voyd/lib/wasm.js";

describe("Function call resolution with method name conflict", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(methodFnConflictVoyd);
    instance = getWasmInstance(mod);
  });

  test("resolves to function when args use labels", (t) => {
    const fn = getWasmFn("test1", instance);
    assert(fn, "test1 exists");
    t.expect(fn()).toEqual(9);
  });
});
