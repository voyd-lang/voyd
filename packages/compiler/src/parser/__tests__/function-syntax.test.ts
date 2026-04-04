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

test("parses explicit open callback effect rows in parameter types", (t) => {
  const code = `
fn run(cb: fn() : (open) -> i32)
  cb()`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        "run",
        [
          ":",
          [":", "cb", ["fn"]],
          ["->", "open", "i32"],
        ],
      ],
      ["block", ["cb"]],
    ],
  ]);
});

test("parses explicit open rows on function declarations", (t) => {
  const code = `
fn call() : (open) -> i32
  1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        ":",
        ["call"],
        ["->", "open", "i32"],
      ],
      ["block", "1"],
    ],
  ]);
});

test("parses explicit open callback effect rows in local let annotations", (t) => {
  const code = `
fn main()
  let cb: fn() : (open) -> i32 = () => 1
  cb()`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      ["main"],
      [
        "block",
        [
          "let",
          [
            "=",
            [
              ":",
              [":", "cb", ["fn"]],
              ["->", "open", "i32"],
            ],
            ["=>", [], "1"],
          ],
        ],
        ["cb"],
      ],
    ],
  ]);
});

test("parses explicit open rows on = declarations", (t) => {
  t.expect(toPlain("fn run() : (open) -> i32 = 1")).toEqual([
    "ast",
    [
      "fn",
      ["=", [":", ["run"], ["->", "open", "i32"]], "1"],
    ],
  ]);
});

test("parses explicit open rows on trait default methods", (t) => {
  const code = `
trait T
  fn run() : (open) -> i32 = 1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "trait",
      "T",
      [
        "block",
        ["fn", ["=", [":", ["run"], ["->", "open", "i32"]], "1"]],
      ],
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
