import { parse } from "../parser.js";
import { test } from "vitest";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON()));

test("does not insert empty block after nested array", (t) => {
  const code = `
    pub fn main() -> i32
      work([
        JsonNumber { val: 23 },
        [
          JsonNumber { val: 43 }
        ]
      ])
  `;

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
            "new_array_unchecked",
            [
              ":",
              "from",
              [
                "fixed_array_literal",
                ["JsonNumber", ["object_literal", [":", "val", "23"]]],
                [
                  "new_array_unchecked",
                  [
                    ":",
                    "from",
                    [
                      "fixed_array_literal",
                      ["JsonNumber", ["object_literal", [":", "val", "43"]]],
                    ],
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ],
  ]);
});
