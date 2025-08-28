import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

const varFixture = `
use std::all

obj Pt {
  x: i32,
  y: i32
}

pub fn from_var() -> i32
  let opts = { x: 2, y: 3 }
  let p = Pt(opts)
  p.x
`;

const paramFixture = `
use std::all

obj Pt {
  x: i32,
  y: i32
}

fn wrap(o: { x: i32, y: i32 }) -> Pt
  Pt(o)

pub fn from_param() -> i32
  let o = { x: 4, y: 5 }
  wrap(o).x
`;

describe("Object init arg expansion", () => {
  test("nominal init accepts var reference", async (t) => {
    const mod = await compile(varFixture);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("from_var", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(2);
  });

  test("nominal init accepts param reference", async (t) => {
    const mod = await compile(paramFixture);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("from_param", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(4);
  });
});

