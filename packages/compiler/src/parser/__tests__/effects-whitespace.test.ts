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

  it("attaches inline handlers to the preceding call when later statements follow", () => {
    const ast = toPlain(`
fn handled()
  try
    test
      boop()
    a::b::c::Async::await(tail):
      tail(1)
    log("done")
`);

    expect(ast).toEqual([
      "ast",
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
                "test",
                [
                  "block",
                  ["boop"],
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
              [
                "log",
                [
                  "new_string",
                  [
                    "fixed_array_literal",
                    "100",
                    "111",
                    "110",
                    "101",
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ]);
  });

  it("keeps inline handlers attached to calls even with trailing statements", () => {
    const ast = toPlain(`
fn handled()
  try
    a::b::c::d::foo()
    a::b::c::d::foo(bar):
      bar(1)
    log("done")
`);

    expect(ast).toEqual([
      "ast",
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
                ["::", ["::", ["::", "a", "b"], "c"], "d"],
                [
                  "foo",
                  [
                    ":",
                    [
                      "::",
                      ["::", ["::", ["::", "a", "b"], "c"], "d"],
                      ["foo", "bar"],
                    ],
                    ["block", ["bar", "1"]],
                  ],
                ],
              ],
              [
                "log",
                [
                  "new_string",
                  [
                    "fixed_array_literal",
                    "100",
                    "111",
                    "110",
                    "101",
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
