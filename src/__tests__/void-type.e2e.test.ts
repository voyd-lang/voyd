import { voidTypeVoyd } from "./fixtures/void-type.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E void return types", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(voidTypeVoyd);
    instance = getWasmInstance(mod);
  });

  test("functions returning voyd ignore body return values", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns correct value").toEqual(5);
  });
});

