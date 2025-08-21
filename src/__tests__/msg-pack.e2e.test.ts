import { msgPackVoyd } from "./fixtures/msg-pack.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

describe("E2E msg pack encode", () => {
  test("encodes number into memory", async (t) => {
    const mod = await compile(msgPackVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "encoded number written").toEqual(42);
  });

  test("encodes string into memory", async (t) => {
    const mod = await compile(msgPackVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run_string", instance);
    assert(fn, "Function exists");
    fn();
    const memory = instance.exports["main_memory"] as WebAssembly.Memory;
    t.expect(decode(memory.buffer.slice(0, 4))).toEqual("abc");
  });
});
