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
      /Available overloads: add\(a: i32, b: i32\) -> i32/,
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
      /Missing fields: w\. Fields with wrong types: y \(expected bool, got i32\)\. Extra fields: z/,
    );
  });

  test("reports when match on union is not exhaustive", async () => {
    const code = `
obj A { x: i32 }
obj B { x: i32 }

type AB = A | B

pub fn main()
  let v: AB = A { x: 1 }
  match(v)
    A: 1
`;
    await expect(compile(code)).rejects.toThrow(
      /Match on AB is not exhaustive.*Missing cases: B/,
    );
  });

  test("reports union match cases mismatch union", async () => {
    const code = `
obj A { x: i32 }
obj B { x: i32 }
obj C { x: i32 }

type AB = A | B

pub fn main()
  let v: AB = A { x: 1 }
  match(v)
    A: 1
    C: 2
    else: 0
`;
    await expect(compile(code)).rejects.toThrow(
      /Match case C is not part of union AB/,
    );
  });

  test("requires default case in object match", async () => {
    const code = `
obj Point { x: i32 }

pub fn main()
  let p = Point { x: 1 }
  match(p)
    Point: 1
`;
    await expect(compile(code)).rejects.toThrow(
      /Match on Point must have a default case/,
    );
  });

  test("requires all match cases to return the same type", async () => {
    const code = `
obj A { x: i32 }
obj B { x: i32 }

type AB = A | B

pub fn main()
  let v: AB = A { x: 1 }
  match(v)
    A: 1
    B: 1.5
`;
    await expect(compile(code)).rejects.toThrow(
      /returns f64 but expected i32/,
    );
  });
});
