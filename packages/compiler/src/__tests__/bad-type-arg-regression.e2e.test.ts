import { describe, test, expect } from "vitest";
import { compile } from "../compiler.js";

describe("E2E bad generic type arg regression", () => {
  test("Map<Strin>(...) reports unknown type and does not crash", async () => {
    const source = `use std::all

pub fn main() -> i32
  let m2 = Map<Strin>([
    ("hey", "hi"),
    ("goodbye", "hey")
  ])
  0
`;
    await expect(compile(source)).rejects.toThrow(/Unrecognized identifier/);
  });
});

