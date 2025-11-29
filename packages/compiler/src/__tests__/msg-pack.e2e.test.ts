import { msgPackVoyd } from "./fixtures/msg-pack.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@voyd/lib/wasm.js";
import { decode, encode } from "@msgpack/msgpack";

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

  test("encodes array into memory", async (t) => {
    t.expect(call("run_array")).toEqual(["hey", "there"]);
  });

  test("encodes map into memory", async (t) => {
    t.expect(call("run_map")).toEqual({
      hey: "there",
      goodbye: "night",
    });
  });
});

describe("E2E msg pack decode", async () => {
  const mod = await compile(msgPackVoyd);
  mod.validate();
  const instance = getWasmInstance(mod);
  const memory = instance.exports["main_memory"] as WebAssembly.Memory;

  const ensureCapacity = (length: number) => {
    const current = memory.buffer.byteLength;
    if (current >= length) {
      return;
    }

    const pageSize = 65536;
    const needed = length - current;
    const pages = Math.ceil(needed / pageSize);
    memory.grow(pages);
  };

  const writeValue = (value: unknown) => {
    const bytes = encode(value);
    ensureCapacity(bytes.length);
    new Uint8Array(memory.buffer, 0, bytes.length).set(bytes);
    return bytes.length;
  };

  test("decodes number from memory", (t) => {
    const len = writeValue(42);
    const fn = getWasmFn("decode_i32", instance);
    assert(fn, "Function decode_i32 exists");
    t.expect(fn(0, len)).toEqual(42);
  });

  test("decodes string from memory", (t) => {
    const len = writeValue("abc");
    const fn = getWasmFn("decode_string", instance);
    assert(fn, "Function decode_string exists");
    const encodedLen = fn(0, len);
    const decoded = decode(memory.buffer.slice(0, encodedLen));
    t.expect(decoded).toEqual("abc");
  });

  test("decodes array from memory", (t) => {
    const len = writeValue(["hey", "there"]);
    const fn = getWasmFn("decode_array", instance);
    assert(fn, "Function decode_array exists");
    const encodedLen = fn(0, len);
    const decoded = decode(memory.buffer.slice(0, encodedLen));
    t.expect(decoded).toEqual(["hey", "there"]);
  });

  test("decodes map from memory", (t) => {
    const len = writeValue({
      hey: "there",
      goodbye: "night",
    });
    const fn = getWasmFn("decode_map", instance);
    assert(fn, "Function decode_map exists");
    const encodedLen = fn(0, len);
    const decoded = decode(memory.buffer.slice(0, encodedLen));
    t.expect(decoded).toEqual({
      hey: "there",
      goodbye: "night",
    });
  });
});
