import { parse } from "../parser.js";
import { test } from "vitest";

const toPlain = (code: string) => JSON.parse(JSON.stringify(parse(code).toJSON()));

test("parses fn with = separator", (t) => {
  t.expect(toPlain("fn fib() = test()")) .toEqual([
    "ast",
    ["fn", ["=", ["fib"], ["test"]]],
  ]);
});

test("parses fn with return type and =", (t) => {
  t.expect(toPlain("fn fib() -> i32 = test()")) .toEqual([
    "ast",
    ["fn", ["=", ["->", ["fib"], "i32"], ["test"]]],
  ]);
});

test("parses fn with effect annotation and =", (t) => {
  t.expect(toPlain("fn fib(): effect -> i32 = test()")) .toEqual([
    "ast",
    [
      "fn",
      ["=", [":", ["fib"], ["->", "effect", "i32"]], ["test"]],
    ],
  ]);
});

test("ignores inline line comments in function bodies", (t) => {
  t.expect(toPlain("fn fib() = // comment\n  test()")) .toEqual([
    "ast",
    ["fn", ["=", ["fib"], ["test"]]],
  ]);
});

test("parses union return types without parentheses", (t) => {
  const code = `
fn describe(x: NumBox) -> Some<i32> | Some<f64>
  x.match()
    Some<f64>: 30
    Some<i32>: x.v + 1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        "->",
        ["describe", [":", "x", "NumBox"]],
        ["|", ["Some", ["generics", "i32"]], ["Some", ["generics", "f64"]]],
      ],
      [
        "block",
        [
          ".",
          "x",
          [
            "match",
            [":", ["Some", ["generics", "f64"]], "30"],
            [":", ["Some", ["generics", "i32"]], ["+", [".", "x", "v"], "1"]],
          ],
        ],
      ],
    ],
  ]);
});

test("parses union return types with multiple pipes without stealing the block", (t) => {
  const code = `
fn choose(x: i32) -> None | Some | Other
  foo(x)`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        "->",
        ["choose", [":", "x", "i32"]],
        ["|", "None", ["|", "Some", "Other"]],
      ],
      ["block", ["foo", "x"]],
    ],
  ]);
});

test("parses module-qualified return types", (t) => {
  const code = `
fn build() -> my_module::MyType
  my_module::MyType { value: 1 }`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      ["->", ["build"], ["::", "my_module", "MyType"]],
      [
        "block",
        [["::", "my_module", "MyType"], ["object_literal", [":", "value", "1"]]],
      ],
    ],
  ]);
});
