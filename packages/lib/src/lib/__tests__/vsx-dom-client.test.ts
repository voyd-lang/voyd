import { describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { callComponentFn } from "../vsx-dom/client.js";

const writeMsgPack = (memory: WebAssembly.Memory, value: unknown): number => {
  const bytes = encode(value);
  new Uint8Array(memory.buffer).set(bytes);
  return bytes.length;
};

describe("vsx-dom/client", () => {
  it("decodes from an explicit memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const expected = { name: "div", children: ["hello"] };
    const componentFn = () => writeMsgPack(memory, expected);
    expect(callComponentFn(componentFn as any, { memory })).toEqual(expected);
  });

  it("resolves memory from instance.exports.memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const expected = { name: "div", children: ["hello"] };
    const componentFn = () => writeMsgPack(memory, expected);
    const instance = { exports: { memory } } as unknown as WebAssembly.Instance;
    expect(callComponentFn(componentFn as any, { instance })).toEqual(expected);
  });

  it("resolves memory from instance.exports.main_memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const expected = { name: "div", children: ["hello"] };
    const componentFn = () => writeMsgPack(memory, expected);
    const instance = {
      exports: { main_memory: memory },
    } as unknown as WebAssembly.Instance;
    expect(callComponentFn(componentFn as any, { instance })).toEqual(expected);
  });
});

