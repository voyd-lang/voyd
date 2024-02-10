export const desugarredAst = [
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
];
