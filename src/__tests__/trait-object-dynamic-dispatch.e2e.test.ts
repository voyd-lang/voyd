import { traitObjectDynamicDispatchVoyd } from "./fixtures/trait-object-dynamic-dispatch.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E trait object dynamic dispatch", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(traitObjectDynamicDispatchVoyd);
    instance = getWasmInstance(mod);
  });

  test("run returns correct value", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns correct value").toEqual(3);
  });
});

