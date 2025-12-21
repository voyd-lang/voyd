import { parse } from "../parser.js";
import { test } from "vitest";

const toPlain = (code: string) => JSON.parse(JSON.stringify(parse(code).toJSON()));

test("treats UpperCamelCase + object literal as a single expression in argument position", (t) => {
  t.expect(toPlain("fn f() = return MyObj { field: 1 }")).toEqual([
    "ast",
    [
      "fn",
      ["=", ["f"], ["return", ["MyObj", ["object_literal", [":", "field", "1"]]]]],
    ],
  ]);
});

test("treats UpperCamelCase + object literal as a single module-qualified expression", (t) => {
  t.expect(toPlain("fn f() = return mod::MyType { field: 1 }")).toEqual([
    "ast",
    [
      "fn",
      [
        "=",
        ["f"],
        [
          "return",
          [
            ["::", "mod", "MyType"],
            ["object_literal", [":", "field", "1"]],
          ],
        ],
      ],
    ],
  ]);
});

test("supports arbitrarily deep module paths for constructor init", (t) => {
  t.expect(toPlain("fn f() = return mod::sub_mod::MyType { field: 1 }")).toEqual([
    "ast",
    [
      "fn",
      [
        "=",
        ["f"],
        [
          "return",
          [
            ["::", ["::", "mod", "sub_mod"], "MyType"],
            ["object_literal", [":", "field", "1"]],
          ],
        ],
      ],
    ],
  ]);
});

test("treats UpperCamelCase generics + object literal as a single expression", (t) => {
  t.expect(toPlain("fn f() = return Some<i32> { value: 1 }")).toEqual([
    "ast",
    [
      "fn",
      [
        "=",
        ["f"],
        [
          "return",
          [
            "Some",
            ["generics", "i32"],
            ["object_literal", [":", "value", "1"]],
          ],
        ],
      ],
    ],
  ]);
});

test("allows passing type and object literal as separate args via params grouping", (t) => {
  t.expect(toPlain("fn f() = my_two_arg_call (Type) { field: 1 }")).toEqual([
    "ast",
    [
      "fn",
      [
        "=",
        ["f"],
        ["my_two_arg_call", "Type", ["object_literal", [":", "field", "1"]]],
      ],
    ],
  ]);
});
