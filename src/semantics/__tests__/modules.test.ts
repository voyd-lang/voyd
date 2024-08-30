import { describe, it } from "node:test";
import assert from "node:assert";
import { registerModules } from "../modules.js";
import { List } from "../../syntax-objects/list.js";

describe("modules", () => {
  it("should register modules", () => {
    const result = registerModules(input);
    console.log("EXPECTED");
    console.log(JSON.stringify(output, undefined, 2));
    console.log("Actual");
    console.log(JSON.stringify(result, undefined, 2));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), output);
  });
});

const input = {
  files: {
    "/Users/drew/projects/void/example.void": new List({
      value: [
        "ast",
        ["use", ["::", ["::", "std", "macros"], "all"]],
        [
          "fn",
          ["fib", [":", "n", "i32"]],
          "->",
          "i32",
          [
            "block",
            [
              "if",
              ["<=", "n", 1],
              [":", "then", ["block", "n"]],
              [
                ":",
                "else",
                [
                  "block",
                  ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]],
                ],
              ],
            ],
          ],
        ],
        [
          "fn",
          ["main"],
          [
            "block",
            ["let", ["=", "x", ["+", 10, ["block", ["+", 20, 30]]]]],
            [
              "let",
              [
                "=",
                "y",
                [
                  "if",
                  [">", "x", 10],
                  [":", "then", ["block", 10]],
                  [":", "else", ["block", 20]],
                ],
              ],
            ],
            [
              "call",
              "this",
              "while",
              [
                "=>",
                [],
                [
                  "if",
                  [">", "x", 10],
                  [":", "then", ["block", ["-=", "x", 1]]],
                  [":", "else", ["block", ["+=", "x", 1]]],
                ],
              ],
            ],
            [
              "let",
              [
                "=",
                "n",
                [
                  "if",
                  [">", ["len", "args"], 1],
                  [
                    ":",
                    "then",
                    [
                      "block",
                      ["log", "console", ["string", "Hey there!"]],
                      ["unwrap", ["parseInt", ["at", "args", 1]]],
                    ],
                  ],
                  [":", "else", ["block", 10]],
                ],
              ],
            ],
            ["let", ["=", "x2", 10]],
            ["let", ["=", "z", ["nothing"]]],
            ["let", ["=", "test_spacing", ["fib", "n"]]],
            ["let", ["=", "result", ["fib", "n"]]],
          ],
        ],
      ],
    }),
    "/Users/drew/projects/void/std/memory.void": new List({
      value: [
        "ast",
        ["use", ["::", ["::", "super", "macros"], "all"]],
        ["global", "let", ["=", "header-size", 8]],
        ["global", "let", ["=", "size-index", 0]],
        ["global", "let", ["=", "type-index", 4]],
        ["global", "var", ["=", "stack-pointer", 0]],
        [
          "pub",
          "fn",
          ["copy", [":", "src", "i32"], [":", "dest", "i32"]],
          "->",
          "i32",
          [
            "block",
            [
              "bnr",
              ["memory", "copy", "void"],
              ["dest", "src", ["size", "src"]],
            ],
            "dest",
          ],
        ],
      ],
    }),
    "/Users/drew/projects/void/std/index.void": new List({
      value: ["ast", ["pub", ["use", ["::", "macros", "all"]]]],
    }),
  },
  srcPath: "/Users/drew/projects/void",
  indexPath: "/Users/drew/projects/void/index.void",
  stdPath: "/Users/drew/projects/void/std",
};

const output = [
  "module",
  "root",
  [
    [
      "module",
      "src",
      [
        [
          "module",
          "example",
          [
            ["use", ["::", ["::", "std", "macros"], "all"]],
            [
              "fn",
              ["fib", [":", "n", "i32"]],
              "->",
              "i32",
              [
                "block",
                [
                  "if",
                  ["<=", "n", 1],
                  [":", "then", ["block", "n"]],
                  [
                    ":",
                    "else",
                    [
                      "block",
                      ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]],
                    ],
                  ],
                ],
              ],
            ],
            [
              "fn",
              ["main"],
              [
                "block",
                ["let", ["=", "x", ["+", 10, ["block", ["+", 20, 30]]]]],
                [
                  "let",
                  [
                    "=",
                    "y",
                    [
                      "if",
                      [">", "x", 10],
                      [":", "then", ["block", 10]],
                      [":", "else", ["block", 20]],
                    ],
                  ],
                ],
                [
                  "call",
                  "this",
                  "while",
                  [
                    "=>",
                    [],
                    [
                      "if",
                      [">", "x", 10],
                      [":", "then", ["block", ["-=", "x", 1]]],
                      [":", "else", ["block", ["+=", "x", 1]]],
                    ],
                  ],
                ],
                [
                  "let",
                  [
                    "=",
                    "n",
                    [
                      "if",
                      [">", ["len", "args"], 1],
                      [
                        ":",
                        "then",
                        [
                          "block",
                          ["log", "console", ["string", "Hey there!"]],
                          ["unwrap", ["parseInt", ["at", "args", 1]]],
                        ],
                      ],
                      [":", "else", ["block", 10]],
                    ],
                  ],
                ],
                ["let", ["=", "x2", 10]],
                ["let", ["=", "z", ["nothing"]]],
                ["let", ["=", "test_spacing", ["fib", "n"]]],
                ["let", ["=", "result", ["fib", "n"]]],
              ],
            ],
          ],
        ],
      ],
    ],
    [
      "module",
      "std",
      [
        [
          "module",
          "memory",
          [
            ["use", ["::", ["::", "super", "macros"], "all"]],
            ["global", "let", ["=", "header-size", 8]],
            ["global", "let", ["=", "size-index", 0]],
            ["global", "let", ["=", "type-index", 4]],
            ["global", "var", ["=", "stack-pointer", 0]],
            [
              "pub",
              "fn",
              ["copy", [":", "src", "i32"], [":", "dest", "i32"]],
              "->",
              "i32",
              [
                "block",
                [
                  "bnr",
                  ["memory", "copy", "void"],
                  ["dest", "src", ["size", "src"]],
                ],
                "dest",
              ],
            ],
          ],
        ],
        ["pub", ["use", ["::", "macros", "all"]]],
      ],
    ],
  ],
];
