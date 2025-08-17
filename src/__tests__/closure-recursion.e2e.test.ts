import { closureRecursionVoyd } from "./fixtures/closure-recursion.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E recursive closures", () => {
  test("closure can call itself recursively", async (t) => {
    const mod = await compile(closureRecursionVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "run returns recursive closure result")
      .toEqual(15);
  });
});
