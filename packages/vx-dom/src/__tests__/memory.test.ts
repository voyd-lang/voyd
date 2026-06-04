import { describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { callComponentFn } from "../memory.js";

const writeMsgPack = (memory: WebAssembly.Memory, value: unknown): number => {
  const bytes = encode(value);
  new Uint8Array(memory.buffer).set(bytes);
  return bytes.length;
};

describe("vx-dom memory boundary", () => {
  it("decodes a render tree from explicit memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const expected = { name: "div", children: ["hello"] };
    const componentFn = () => writeMsgPack(memory, expected);

    expect(callComponentFn(componentFn, { memory })).toEqual(expected);
  });

  it("resolves memory from instance exports", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const expected = { name: "div", children: ["hello"] };
    const componentFn = () => writeMsgPack(memory, expected);
    const instance = {
      exports: { main_memory: memory },
    } as unknown as WebAssembly.Instance;

    expect(callComponentFn(componentFn, { instance })).toEqual(expected);
  });
});
