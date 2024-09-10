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
    const test1 = getWasmFn("test1", instance);
    const test2 = getWasmFn("test2", instance);
    const test3 = getWasmFn("test3", instance);
    const test4 = getWasmFn("test4", instance);
    const test5 = getWasmFn("test5", instance);
    const test6 = getWasmFn("test6", instance);
    const test7 = getWasmFn("test7", instance);
    const test8 = getWasmFn("test8", instance);
    const test9 = getWasmFn("test9", instance);
    const test10 = getWasmFn("test10", instance);
    const test11 = getWasmFn("test11", instance);
    assert(test1, "Test1 exists");
    assert(test2, "Test2 exists");
    assert(test3, "Test3 exists");
    assert(test4, "Test4 exists");
    assert(test5, "Test5 exists");
    assert(test6, "Test6 exists");
    assert(test7, "Test7 exists");
    assert(test8, "Test8 exists");
    assert(test9, "Test9 exists");
    assert(test10, "Test10 exists");
    assert(test11, "Test11 exists");

    // Static method resolution tests
    t.expect(test1(), "test 1 returns correct value").toEqual(13);
    t.expect(test2(), "test 2 returns correct value").toEqual(1);
    t.expect(test3(), "test 3 returns correct value").toEqual(2);
    t.expect(test4(), "test 4 returns correct value").toEqual(52);

    // Match based type narrowing (and basic gc)
    t.expect(test5(), "test 5 returns correct value").toEqual(52);
    t.expect(test6(), "test 6 returns correct value").toEqual(21);
    t.expect(test7(), "test 7 returns correct value").toEqual(-1);

    // Generic type test
    t.expect(test8(), "test 8 returns correct value").toEqual(143);

    // Generic object type test
    t.expect(test9(), "test 9 returns correct value").toEqual(7.5);
    t.expect(test10(), "test 10 returns correct value").toEqual(12);
    t.expect(test11(), "test 11 returns correct value").toEqual(4);
  });

  test("Compiler can do tco", async (t) => {
    const spy = vi.spyOn(rCallUtil, "returnCall");
    await compile(tcoText);
    const did = spy.mock.calls.some((call) => call[1].startsWith("fib"));
    t.expect(did);
  });
});
