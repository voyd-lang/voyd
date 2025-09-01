import { vsxVoyd } from "./fixtures/vsx.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

describe("E2E HTML reader macro -> vsx::create_element", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(vsxVoyd);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  test("main HTML compiles and encodes expected MsgPack", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "run exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    t.expect(decoded).toEqual({
      name: "div",
      attributes: { class: "size-full rounded bg-black" },
      children: [
        {
          name: "p",
          attributes: { class: "prose" },
          children: ["Hello World!"],
        },
        {
          name: "p",
          attributes: { class: "prose" },
          children: ["I am M87"],
        },
      ],
    });
  });
});

