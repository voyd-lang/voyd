import { parse } from "../parser.js";
import { test } from "vitest";

const toPlain = (code: string) => JSON.parse(JSON.stringify(parse(code).toJSON()));

test("does not insert empty block after nested array", (t) => {
  const code = [
    "pub fn main() -> i32",
    "  work([",
    "    JsonNumber { val: 23 },",
    "    [",
    "      JsonNumber { val: 43 }",
    "    ]",
    "  ])",
  ].join("\n");

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "pub",
      "fn",
      ["->", ["main"], "i32"],
      [
        "block",
        [
          "work",
          [
            "array",
            ["JsonNumber", ["object", [":", "val", 23]]],
            ["array", ["JsonNumber", ["object", [":", "val", 43]]]]
          ]
        ]
      ]
    ]
  ]);
});
