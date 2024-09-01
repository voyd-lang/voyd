import { e2eVoidText, gcVoidText } from "./fixtures/e2e-file.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E Compiler Pipeline", () => {
  test("Compiler can compile and run a basic void program", async (t) => {
    const mod = await compile(e2eVoidText);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "Main function returns correct value").toEqual(55);
  });

  test("Compiler can compile gc objects and map correct fns", async (t) => {
    const mod = await compile(gcVoidText);
    const instance = getWasmInstance(mod);
    const test1 = getWasmFn("test1", instance);
    const test2 = getWasmFn("test2", instance);
    const test3 = getWasmFn("test3", instance);
    const test4 = getWasmFn("test4", instance);
    assert(test1, "Test1 exists");
    assert(test2, "Test2 exists");
    assert(test3, "Test3 exists");
    assert(test4, "Test4 exists");
    t.expect(test1(), "test 1 returns correct value").toEqual(13);
    t.expect(test2(), "test 2 returns correct value").toEqual(1);
    t.expect(test3(), "test 3 returns correct value").toEqual(2);
    t.expect(test4(), "test 4 returns correct value").toEqual(52);
  });
});
