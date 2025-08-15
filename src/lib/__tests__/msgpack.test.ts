import { describe, test, expect } from "vitest";
import { encode, decode, encodeTo, decodeFrom } from "../msgpack.js";

describe("MessagePack", () => {
  test("round trip basic values", () => {
    const values: any[] = [
      null,
      true,
      false,
      0,
      1,
      -1,
      127,
      -33,
      1.5,
      "hi",
      [1, 2, 3],
      { a: 1, b: "x" },
    ];
    for (const v of values) {
      const bytes = encode(v);
      const out = decode(bytes);
      expect(out).toEqual(v);
    }
  });

  test("linear memory round trip", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const mem = new Uint8Array(memory.buffer);
    const value = { foo: 1, bar: ["baz", true, null, 4] };
    const len = encodeTo(value, mem, 0);
    const out = decodeFrom(mem, 0, len);
    expect(out).toEqual(value);
  });
});

