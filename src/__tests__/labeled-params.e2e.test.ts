import { labeledParamsVoyd } from "./fixtures/labeled-params.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E labeled parameters", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(labeledParamsVoyd);
    instance = getWasmInstance(mod);
  });

  test("function with normal labels runs", (t) => {
    const fn = getWasmFn("normal_labels", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "normal_labels returns correct value").toEqual(3);
  });

  test("function mixing normal and external labels runs", (t) => {
    const fn = getWasmFn("mixed_labels", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "mixed_labels returns correct value").toEqual(7);
  });

  test("object argument expands into labeled params", (t) => {
    const fn = getWasmFn("move_vec", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "move_vec returns correct value").toEqual(6);
  });

  test("object literal argument expands into labeled params", (t) => {
    const fn = getWasmFn("move_literal", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "move_literal returns correct value")
      .toEqual(6);
  });
});
