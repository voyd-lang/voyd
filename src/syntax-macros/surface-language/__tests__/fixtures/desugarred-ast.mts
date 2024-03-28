export const desugarredAst = [
  ["use", ["::", ["::", "std", "macros"], "all"]],
  ["use", ["::", ["::", "std", "io"], ["object", "read"]]],
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
          ["block", ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]]],
        ],
      ],
    ],
  ],
  [
    "macro_let",
    [
      "=",
      "extract_parameters",
      [
        "=>",
        ["definitions"],
        ["block", ["concat", ["`", "parameters"], ["slice", "definitions", 1]]],
      ],
    ],
  ],
  [
    "if",
    [">", "x", 10],
    [":", "then", ["block", 10]],
    [":", "else", ["block", 20]],
  ],
  [
    "reduce",
    "array",
    0,
    1,
    2,
    [":", "hey", ["=>", [], ["block", ["log", "val"], ["+", "acc", "val"]]]],
    [":", "with", ["=>", [], 0]],
  ],
  ["+", 10, 3],
  [
    "let",
    [
      "=",
      "a",
      [
        "*",
        [
          "+",
          [
            "reduce",
            "array",
            0,
            ["=>", ["acc", "val"], ["block", ["+", "acc", "val"]]],
          ],
          10,
        ],
        3,
      ],
    ],
  ],
  [
    "fn",
    ["main"],
    [
      "block",
      [
        "let",
        ["=", "a", ["+", ["...", ["hey", "test"]], ["now", ["&", "other"]]]],
      ],
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
        "let",
        [
          "=",
          "n",
          [
            "block",
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
      ],
      ["let", ["=", "x2", 10]],
      ["let", ["=", "z", ["nothing"]]],
      ["let", ["=", "a", ["boop", "hello", 1]]],
      ["let", ["=", "test_spacing", ["fib", "n"]]],
      ["let", ["=", "result", ["fib", "n"]]],
      ["let", ["=", "x", ["&", "hey"]]],
      ["$", "hey"],
      ["$@", ["hey"]],
      ["$", ["hey"]],
      ["$", ["extract", "equals_expr", 2]],
      ["block", ["$", "body"]],
      ["+", "x", 5],
      ["+", ["+", "x", "y"], 10],
      ["+", ["*", "x", "y"], 10],
      ["x"],
      "x",
    ],
  ],
];
