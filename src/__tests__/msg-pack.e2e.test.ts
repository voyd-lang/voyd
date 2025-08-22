import { msgPackVoyd } from "./fixtures/msg-pack.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

describe("E2E msg pack encode", async () => {
  const mod = await compile(msgPackVoyd);
  mod.validate();
  const instance = getWasmInstance(mod);
  const memory = instance.exports["main_memory"] as WebAssembly.Memory;

  const call = (fnName: string): unknown => {
    const fn = getWasmFn(fnName, instance);
    assert(fn, `Function, ${fnName}, exists`);
    const index = fn();
    return decode(memory.buffer.slice(0, index));
  };

  test("encodes number into memory", async (t) => {
    t.expect(call("run_i32"), "encoded number written").toEqual(42);
  });

  test("encodes string into memory", async (t) => {
    t.expect(call("run_string")).toEqual("abc");
  });
});
