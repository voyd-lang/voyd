import { test } from "vitest";
import { compile } from "../compiler.js";

test("reports helpful overload mismatch including applied generics (module fn)", async (t) => {
  const source = `use std::all

fn takes(arr: Array<String>) -> void 0

pub fn main()
  takes([1]) // wrong: expects Array<String>
`;
  await t
    .expect(compile(source))
    .rejects.toThrow(
      /Available overloads: takes\(arr: Array<String>\) -> void/s
    );
});
