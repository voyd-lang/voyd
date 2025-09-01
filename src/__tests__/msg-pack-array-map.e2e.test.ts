import { msgPackArrayMapVoyd } from "./fixtures/msg-pack-array-map.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

describe("E2E Array.map to MsgPack children", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(msgPackArrayMapVoyd);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  test("map closure infers MsgPack return type", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "run exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    t.expect(decoded).toEqual({
      name: "div",
      attributes: {},
      children: [
        [
          { name: "p", attributes: {}, children: ["hi", "Alex"] },
          { name: "p", attributes: {}, children: ["hi", "Abby"] },
        ],
      ],
    });
  });
});
