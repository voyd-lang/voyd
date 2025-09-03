import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { genericsUnionInferNegativeVoyd } from "./fixtures/generics-union-infer-negative.js";
import { decode } from "@msgpack/msgpack";

// One combined source string with all positive inference tests as exported fns
const inferenceVoyd = `
use std::all
use std::msg_pack::MsgPack
use std::vsx::create_element
use std::msg_pack

// ---- generics-infer ----
fn add<T>(a: T, b: T) -> T
  a + b

pub fn test1() -> i32
  add(1, 2)

fn head<T>(arr: Array<T>) -> i32
  42

pub fn test2() -> i32
  let arr: Array<i32> = [42]
  head(arr)

fn wrap<T>(pairs: Array<(String, T)>) -> i32
  42

pub fn test3() -> i32
  let arr: Array<(String, i32)> = [("a", 42)]
  wrap(arr)

fn reduce_test<T>({ arr: Array<T>, start: T, reducer cb: (acc: T, current: T) -> T }) -> T
  let iterator = arr.iterate()
  let reducer: (acc: T) -> T = (acc: T) =>
    iterator.next().match(opt)
      Some<T>:
        reducer(cb(acc, opt.value))
      None:
        acc
  reducer(start)

pub fn test4() -> i32
  let arr: Array<i32> = [1, 2, 3]
  reduce_test<i32> arr: arr start: 0 reducer: (acc: i32, current: i32) => acc + current

// ---- generics-union-infer ----
fn use_union<T>(val: Array<T> | String) -> i32
  7

type Html<T> = Array<T> | String

fn use_alias<T>(val: Html<T>) -> i32
  9

pub fn test5() -> i32
  use_union(if true then: "x" else: [1, 2, 3])

pub fn test6() -> i32
  use_alias(if true then: "x" else: [1, 2, 3])

// ---- empty-array-infer ----
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

pub fn test7() -> i32
  let _m1 = make_map("div", [("hello", "there")], ["hi"]) // works
  let _m2 = make_map("div", [], []) // previously failed to infer element types
  1

// ---- map-init-infer ----
pub fn test8() -> i32
  let map = Map([
    ("a", 1),
    ("b", 2)
  ])
  map.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1

// ---- msg-pack-array-map inference without explicit map type arg ----
pub fn component9() -> Map<MsgPack>
  let a = ["Alex", "Abby"]
  <div>
    {a.map(item => <p>hi {item}</p>)}
  </div>

pub fn test9() -> i32
  msg_pack::encode(component9())

// ---- msg-pack-array-map with explicit map type arg ----
pub fn component10() -> Map<MsgPack>
  let a = ["Alex", "Abby"]
  <div>
    {a.map<MsgPack>(item => <p>hi {item}</p>)}
  </div>

pub fn test10() -> i32
  msg_pack::encode(component10())
`;

describe("E2E Inference (kitchen sink)", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(inferenceVoyd);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  const expecteds = [3, 42, 42, 6, 7, 9, 1, 1];
  for (let i = 0; i < expecteds.length; i++) {
    test(`test${i + 1} returns expected`, (t) => {
      const fn = getWasmFn(`test${i + 1}`, instance);
      assert(fn, `test${i + 1} exists`);
      t.expect(fn()).toEqual(expecteds[i]);
    });
  }

  test("rejects arg union that is a strict superset of parameter union", async (t) => {
    await t.expect(compile(genericsUnionInferNegativeVoyd)).rejects.toThrow();
  });

  test("msg-pack array.map infers MsgPack in closure return (no map<...> annotation)", (t) => {
    const fn = getWasmFn("test9", instance);
    assert(fn, "test9 exists");
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

  test("msg-pack array.map with explicit type annotation produces same structure", (t) => {
    const fn = getWasmFn("test10", instance);
    assert(fn, "test10 exists");
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
