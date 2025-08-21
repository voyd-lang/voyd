import { describe, test } from "vitest";
import { readJson, writeJson } from "../lib/json.js";

describe("JSON MessagePack via linear memory", () => {
  test("roundtrip", (t) => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = { exports: { memory } } as unknown as WebAssembly.Instance;
    const value = { a: 1, b: [true, "hi"], c: null };
    const ptr = 0;
    const len = writeJson(value, instance, ptr);
    const result = readJson<typeof value>(ptr, len, instance);
    t.expect(result).toEqual(value);
  });
});
