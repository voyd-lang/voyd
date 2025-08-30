import { describe, test } from "vitest";
import { compile } from "../compiler.js";

describe("Control Flow sugar: if match", () => {
  test("compiles if-match without binder", async () => {
    const src = `use std::all

obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

pub fn main() -> i32
  let opt: Optional<i32> = Some<i32> { value: 4 }
  if opt.match(Some<i32>) then:
    opt.value
  else:
    -1
`;
    await compile(src);
  });

  test("compiles if-match with binder", async () => {
    const src = `use std::all

obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

pub fn main() -> i32
  let opt: Optional<i32> = Some<i32> { value: 7 }
  if opt.match(x, Some<i32>) then:
    x.value
  else:
    -1
`;
    await compile(src);
  });

  test("compiles while-match with binder", async () => {
    const src = `use std::all

pub fn main() -> i32
  let a = [1, 2, 3]
  let iterator = a.iterate()
  var sum = 0
  while iterator.next().match(x, Some<i32>) do:
    sum = sum + x.value
  sum
`;
    await compile(src);
  });

  test("compiles if-optional-unwrap (?=) sugar", async () => {
    const src = `use std::all

obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

pub fn main() -> i32
  let opt: Optional<i32> = Some<i32> { value: 5 }
  if x ?= opt then:
    x
  else:
    -1
`;
    await compile(src);
  });

  test("compiles while-optional-unwrap (?=) sugar", async () => {
    const src = `use std::all

pub fn main() -> i32
  let a = [1, 2, 3]
  let iterator = a.iterate()
  var sum = 0
  while n ?= iterator.next() do:
    sum = sum + n
  sum
`;
    await compile(src);
  });
});
