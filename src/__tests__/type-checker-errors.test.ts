import { expect, test } from "vitest";
import { compile } from "../compiler.js";

test("provides available overloads when call types mismatch", async () => {
  const source = `use std::all

fn add(a: i32, b: i32) -> i32
  a + b

pub fn main()
  add(true, 2)
`;
  await expect(compile(source)).rejects.toThrow(
    /Available overloads: add\(a: i32, b: i32\) -> i32/
  );
});
