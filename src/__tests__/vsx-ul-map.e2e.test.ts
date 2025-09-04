import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";

const source = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

fn component() -> Map<MsgPack>
  let a = ["Alex", "Abby"]
  <div>
    <ul>
      {a.map(item => <li>hi {item}</li>)}
    </ul>
  </div>

pub fn test_ul_map() -> i32
  msg_pack::encode(component())
`;

describe("VSX <ul> children map", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(source);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  test("compiles and encodes expected structure", (t) => {
    const fn = getWasmFn("test_ul_map", instance);
    assert(fn, "test_ul_map exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    t.expect(decoded).toEqual({
      name: "div",
      attributes: {},
      children: [
        {
          name: "ul",
          attributes: {},
          children: [
            [
              { name: "li", attributes: {}, children: ["hi ", "Alex"] },
              { name: "li", attributes: {}, children: ["hi ", "Abby"] },
            ],
          ],
        },
      ],
    });
  });
});
