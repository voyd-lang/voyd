import { traitObjectsVoyd } from "./fixtures/trait-object.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E trait objects", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(traitObjectsVoyd);
    instance = getWasmInstance(mod);
  });

  test("dynamic dispatch works", (t) => {
    const fn = getWasmFn("dynamic_dispatch", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "dynamic_dispatch returns correct value")
      .toEqual(3);
  });

  test("resolves methods with multiple parameters and overloads", (t) => {
    const fn = getWasmFn("multiple_params", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "multiple_params returns correct value")
      .toEqual(2);
  });

  test("supports generic trait objects", (t) => {
    const fn = getWasmFn("generic_trait", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "generic_trait returns correct value")
      .toEqual(1);
  });

  test("handles nested generic trait parameters", (t) => {
    const fn = getWasmFn("nested_generic_param", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "nested_generic_param returns correct value")
      .toEqual(4);
  });
});

