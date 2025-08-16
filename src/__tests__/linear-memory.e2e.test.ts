import {
  linearMemoryVoyd,
  linearMemoryModuleVoyd,
} from "./fixtures/linear-memory.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E linear memory", () => {
  test("load/store roundtrip with picked imports", async (t) => {
    const mod = await compile(linearMemoryVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns stored value").toEqual(42);
  });

  test("load/store roundtrip with module access", async (t) => {
    const mod = await compile(linearMemoryModuleVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns stored value").toEqual(42);
  });
});
