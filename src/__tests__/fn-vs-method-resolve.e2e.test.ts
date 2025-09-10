import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

const program = `
use std::all

fn reduce<T>(arr: Array<T>, { start: T, reducer cb: (acc: T, current: T) -> T }) -> T
  let iterator = arr.iterate()
  let reducer: (acc: T) -> T = (acc: T) -> T =>
    iterator.next().match(opt)
      Some<T>:
        reducer(cb(acc, opt.value))
      None:
        acc
  reducer(start)

fn add<T>(a: T, b: T)
  a + b

pub fn main() -> i32
  [1, 2, 3]
    .reduce<i32> start: 0 reducer: (acc: i32, current: i32) =>
      acc + current
    .add(3)
`;

describe("call resolution chooses function when method shares name", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(program);
    instance = getWasmInstance(mod);
  });

  test("main returns expected", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "main exists");
    t.expect(fn()).toEqual(9);
  });
});
