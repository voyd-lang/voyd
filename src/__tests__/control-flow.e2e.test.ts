import { describe, test } from "vitest";
import { compile } from "../compiler.js";
import { controlFlowText } from "./fixtures/e2e-file.js";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";
import assert from "node:assert";

describe("Control Flow sugar", () => {
  const timeout = 60000;

  test("if/while: match and := sugar works and returns expected values", { timeout }, async (t) => {
    const mod = await compile(controlFlowText);
    const instance = getWasmInstance(mod);

    const expect = (name: string, v: unknown) => {
      const fn = getWasmFn(name, instance);
      assert(fn, `${name} exists`);
      t.expect(fn(), `${name} returns correct value`).toEqual(v);
    };

    expect("test1", 4);
    expect("test2", 7);
    expect("test4", 5);
    expect("test6", 6);
    expect("test7", 5);
    expect("test8", 4);
    expect("test9", -1);
    expect("test10", 1);
    expect("test11", 4);
    expect("test13", 3);
    expect("test14", 1);
    expect("test15", 3);
  });
});
