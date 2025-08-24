import { compile } from "../compiler.js";
import { describe, test } from "vitest";

describe("Type checker error messages", () => {
  test("reports variable initialization type mismatch clearly", async (t) => {
    const code = `
pub fn main()
  let x: i32 = 1.5
  x
`;
    await t.expect(compile(code)).rejects.toThrow(
      /x is declared as i32 but initialized with f64/
    );
  });

  test("reports assignment type mismatch clearly", async (t) => {
    const code = `
pub fn main()
  var x: i32 = 1
  x = 1.5
  x
`;
    await t.expect(compile(code)).rejects.toThrow(
      /Cannot assign f64 to variable x of type i32/
    );
  });
});
