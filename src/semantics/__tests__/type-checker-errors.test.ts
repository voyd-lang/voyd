import { expect, test, describe } from "vitest";
import { compile } from "../../compiler.js";

describe("Type checker error messages", () => {
  test("reports variable initialization type mismatch clearly", async (t) => {
    const code = `
pub fn main()
  let x: i32 = 1.5
  x
`;
    await t
      .expect(compile(code))
      .rejects.toThrow(/x is declared as i32 but initialized with f64/);
  });

  test("reports assignment type mismatch clearly", async (t) => {
    const code = `
pub fn main()
  var x: i32 = 1
  x = 1.5
  x
`;
    await t
      .expect(compile(code))
      .rejects.toThrow(/Cannot assign f64 to variable x of type i32/);
  });

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

  test("reports object literal init mismatches clearly", async () => {
    const code = `
obj Point {
  x: i32,
  y: bool,
  w: f64
}

pub fn main()
  Point { x: 1, y: 2, z: 3 }
`;
    await expect(compile(code)).rejects.toThrow(
      /Missing fields: w\. Fields with wrong types: y \(expected bool, got i32\)\. Extra fields: z/
    );
  });
});
