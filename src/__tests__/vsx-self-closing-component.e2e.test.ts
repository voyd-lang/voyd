import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

const source = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

pub fn Card({ name: String, children?: Array<MsgPack> })
  let content = if c := children then: c else: []

  <div class="card">
    <h1 class="card-title">Hello {name}</h1>
    {content}
  </div>

pub fn App()
  <div class="wrap">
    <Card name="No kids" />
  </div>

pub fn run() -> i32
  msg_pack::encode(App())
`;

describe("VSX self-closing component", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(source);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  test("compiles with no children prop passed", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "run exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    t.expect(decoded).toEqual({
      name: "div",
      attributes: { class: "wrap" },
      children: [
        {
          name: "div",
          attributes: { class: "card" },
          children: [
            {
              name: "h1",
              attributes: { class: "card-title" },
              children: ["Hello ", "No kids"],
            },
            [],
          ],
        },
      ],
    });
  });
});

