import {
  e2eVoidText,
  kitchenSink,
  goodTypeInferenceText,
  tcoText,
} from "./fixtures/e2e-file.js";
import { compile } from "../compiler.js";
import { describe, test, vi } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import * as rCallUtil from "../assembler/return-call.js";

describe("E2E Compiler Pipeline", () => {
  test("Compiler can compile and run a basic void program", async (t) => {
    const mod = await compile(e2eVoidText);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "Main function returns correct value").toEqual(55);
  });

  test("Compiler has good inference", async (t) => {
    const mod = await compile(goodTypeInferenceText);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "Main function returns correct value").toEqual(55n);
  });

  test("Compiler kitchen sink", async (t) => {
    const mod = await compile(kitchenSink);
    const instance = getWasmInstance(mod);
    t.expect(mod.validate(), "Module is valid");
    const tests = (expectedValues: unknown[]) =>
      expectedValues.forEach((v, i) => {
        const test = getWasmFn(`test${i + 1}`, instance);
        assert(test, `Test${i + 1} exists`);
        t.expect(test(), `test ${i + 1} returns correct value`).toEqual(v);
      });

    tests([
      13, // Static method resolution tests
      1,
      2,
      52,
      52, // Match based type narrowing (and basic gc)
      21,
      -1,
      143, // Generic type test
      7.5, // Generic object type test
      12,
      4,
      597, // Modules
      9, // Generic impls
      17,
      82,
      3,
      42,
    ]);
  });

  test("Compiler can do tco", async (t) => {
    const spy = vi.spyOn(rCallUtil, "returnCall");
    await compile(tcoText);
    const did = spy.mock.calls.some((call) => call[1].startsWith("fib"));
    t.expect(did);
  });
});
