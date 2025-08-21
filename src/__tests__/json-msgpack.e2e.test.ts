import assert from "node:assert";
import { describe, test } from "vitest";
import { compile } from "../compiler.js";
import { readJson } from "../lib/json.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { jsonMsgpackVoyd } from "./fixtures/json-msgpack.js";

describe("JSON MessagePack via linear memory", () => {
  test("roundtrip", async (t) => {
    const mod = await compile(jsonMsgpackVoyd);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    const ptr = 0;
    const expected = { a: 1, b: [true, "hi"], c: null };
    const len = fn(ptr);
    const result = readJson<typeof expected>(ptr, len, instance);
    t.expect(result).toEqual(expected);
  });
});
