import { closureVoyd } from "./fixtures/closure.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closures", () => {
  test("closure captures variables", async (t) => {
    const mod = await compile(closureVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns closure result").toEqual(42);
  });
});
