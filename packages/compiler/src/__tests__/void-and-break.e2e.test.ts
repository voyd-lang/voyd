import { describe, test } from "vitest";
import { compile } from "../compiler.js";

describe("void value and break typing", () => {
  const timeout = 60000;

  test("allows value-level void in function body", { timeout }, async () => {
    const source = `use std::all

fn noop() -> void void

pub fn main()
  noop()
`;
    await compile(source);
  });

  test("treats break as void in match arms", { timeout }, async () => {
    const source = `use std::all

  pub fn main()
  let o = None {}
  var i = 0
  while i < 1 do:
    match(o)
      None: break
      else: void
    i = i + 1
`;
    await compile(source);
  });
});
