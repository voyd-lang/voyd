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
