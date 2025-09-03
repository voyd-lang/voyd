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

test("rejects closure with incompatible return type", async (t) => {
  const source = `use std::all

fn takes(cb: () -> i32) -> void 0

pub fn main()
  takes(() => "str")
`;
  await t
    .expect(compile(source))
    .rejects.toThrow(/No overload matches/);
});
