import { closuresVoyd } from "./fixtures/closures.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closures", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(closuresVoyd);
    instance = getWasmInstance(mod);
  });

  test("closure captures variables", (t) => {
    const fn = getWasmFn("capture", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "capture returns closure result").toEqual(42);
  });

  test("closures can be passed as parameters", (t) => {
    const fn = getWasmFn("params", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "params returns correct value").toEqual(10);
  });

  test("infers single parameter closure", (t) => {
    const fn = getWasmFn("param_infer_one", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "param_infer_one returns correct value").toEqual(10);
  });

  test("infers two parameter closure", (t) => {
    const fn = getWasmFn("param_infer_two", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "param_infer_two returns correct value").toEqual(7);
  });

  test("infers labeled closure parameters", (t) => {
    const fn = getWasmFn("param_infer_labeled", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "param_infer_labeled returns correct value").toEqual(6);
  });

  test("closures can call other closures", (t) => {
    const fn = getWasmFn("calls_closure", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "calls_closure returns updated value").toEqual(4);
  });

  test("closure can call itself recursively", (t) => {
    const fn = getWasmFn("recursive", instance);
    assert(fn, "Function exists");
    t
      .expect(fn(), "recursive returns recursive closure result")
      .toEqual(15);
  });

  test("pipes value through closures", (t) => {
    const fn = getWasmFn("pipe", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "pipe returns piped closure result").toEqual(25);
  });
});

