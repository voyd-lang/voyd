import { compile } from "../../compiler.js";
import { describe, test } from "vitest";
import { vi } from "vitest";

describe("object mutability", () => {
  test("allows mutation when parameter is marked mutable", async (t) => {
    const source = `use std::all

obj VecTest { x: i32 }

fn bump(&v: VecTest) -> voyd
  v.x = v.x + 1

pub fn main() -> i32
  0
`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await compile(source);
    t.expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("supports labeled parameters", async (t) => {
    const source = `use std::all

obj VecTest { x: i32 }

fn bump({ &v: VecTest }) -> voyd
  v.x = v.x + 1

pub fn main() -> i32
  0
`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await compile(source);
    t.expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
