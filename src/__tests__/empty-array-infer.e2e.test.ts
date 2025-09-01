import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

const source = `
use std::all
use std::msg_pack::MsgPack

pub fn make_map(
  name: String,
  attributes: Array<(String, MsgPack)>,
  children: Array<MsgPack>
) -> Map<MsgPack>
  let attributeMap = Map<MsgPack>(attributes)
  Map<MsgPack>([
    ("name", name),
    ("attributes", attributeMap),
    ("children", children)
  ])

pub fn main() -> i32
  let _m1 = make_map("div", [("hello", "there")], ["hi"]) // works
  let _m2 = make_map("div", [], []) // previously failed to infer element types
  1
`;

describe("E2E empty array element type inference in call args", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(source);
    instance = getWasmInstance(mod);
  });

  test("main returns 1 (no type error)", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "main exists");
    t.expect(fn()).toEqual(1);
  });
});

