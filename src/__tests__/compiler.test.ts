import {
  e2eVoidText,
  gcVoidText,
  genericsText,
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

  test("Compiler can compile gc objects and map correct fns", async (t) => {
    const mod = await compile(gcVoidText);
    const instance = getWasmInstance(mod);
    const test1 = getWasmFn("test1", instance);
    const test2 = getWasmFn("test2", instance);
    const test3 = getWasmFn("test3", instance);
    const test4 = getWasmFn("test4", instance);
    const test5 = getWasmFn("test5", instance);
    const test6 = getWasmFn("test6", instance);
    const test7 = getWasmFn("test7", instance);
    assert(test1, "Test1 exists");
    assert(test2, "Test2 exists");
    assert(test3, "Test3 exists");
    assert(test4, "Test4 exists");
    assert(test5, "Test5 exists");
    assert(test6, "Test6 exists");
    assert(test7, "Test7 exists");
    t.expect(test1(), "test 1 returns correct value").toEqual(13);
    t.expect(test2(), "test 2 returns correct value").toEqual(1);
    t.expect(test3(), "test 3 returns correct value").toEqual(2);
    t.expect(test4(), "test 4 returns correct value").toEqual(52);
    t.expect(test5(), "test 5 returns correct value").toEqual(52);
    t.expect(test6(), "test 6 returns correct value").toEqual(21);
    t.expect(test7(), "test 7 returns correct value").toEqual(-1);
  });

  test("Compiler can do tco", async (t) => {
    const spy = vi.spyOn(rCallUtil, "returnCall");
    await compile(tcoText);
    t.expect(spy).toHaveBeenCalledTimes(1);
  });

  test("Generic fn compilation", async (t) => {
    const mod = await compile(genericsText);
    const instance = getWasmInstance(mod);
    const main = getWasmFn("main", instance);
    assert(main, "Main exists");
    t.expect(main(), "main 1 returns correct value").toEqual(143);
  });
});
