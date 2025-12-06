import { describe, expect, it } from "vitest";

import { parse } from "../parser.js";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON()));

describe("effects whitespace with qualified handlers", () => {
  it("parses dedented qualified handlers as try clauses", () => {
    const ast = toPlain(`
eff Async
  fn await(tail) -> i32

fn handled()
  try
    a::b::c::Async::await()
  a::b::c::Async::await(tail):
    tail(1)
`);

    expect(ast).toEqual([
      "ast",
      [
        "eff",
        "Async",
        ["block", ["fn", ["->", ["await", "tail"], "i32"]]],
      ],
      [
        "fn",
        ["handled"],
        [
          "block",
          [
            "try",
            [
              "block",
              [
                "::",
                ["::", ["::", ["::", "a", "b"], "c"], "Async"],
                ["await"],
              ],
            ],
            [
              ":",
              [
                "::",
                ["::", ["::", ["::", "a", "b"], "c"], "Async"],
                ["await", "tail"],
              ],
              ["block", ["tail", "1"]],
            ],
          ],
        ],
      ],
    ]);
  });

  it("injects inlined handlers into the call expression", () => {
    const ast = toPlain(`
eff Async
  fn await(tail) -> i32

fn handled()
  try
    a::b::c::Async::await()
    a::b::c::Async::await(tail):
      tail(1)
`);

    expect(ast).toEqual([
      "ast",
      [
        "eff",
        "Async",
        ["block", ["fn", ["->", ["await", "tail"], "i32"]]],
      ],
      [
        "fn",
        ["handled"],
        [
          "block",
          [
            "try",
            [
              "block",
              [
                "::",
                ["::", ["::", ["::", "a", "b"], "c"], "Async"],
                [
                  "await",
                  [
                    ":",
                    [
                      "::",
                      ["::", ["::", ["::", "a", "b"], "c"], "Async"],
                      ["await", "tail"],
                    ],
                    ["block", ["tail", "1"]],
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ]);
  });
});
