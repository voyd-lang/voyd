export const desugarredAst = [
  "ast",
  ["use", ["::", ["::", "std", "macros"], "all"]],
  [
    "use",
    ["::", ["::", "std", "io"], ["object", "read", [":", "write", "io_write"]]],
  ],
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
    "let",
    [
      "=",
      "x",
      ["my_func", ["add", 1, 2], ["=>", [], ["block", ["hello"]]], ["+", 3, 4]],
    ],
  ],
  [
    "closure_param_test",
    1,
    ["=>", [], "a"],
    3,
    ["=>", [], ["block", ["hey", "there"]]],
    4,
    ["=>", [], 5],
    ["=>", [], ["block", 6]],
    ["=>", [], ["block", 7]],
    8,
  ],
  ["let", ["=", ["tuple", "x", "y"], ["tuple", 1, 2]]],
  ["+", ["Array", ["generics", "Hey", "There"], 1, 2, 3], 3],
  ["obj", ["Test", ["generics", "T"]], ["object", [":", "c", "i32"]]],
  ["fn", ["test", ["generics", "T"], [":", "a", 1]], "->", "i32"],
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
      [
        "let",
        [
          "=",
          "vec",
          [
            "object",
            [":", "x", 10],
            [":", "y", ["Point", ["object", [":", "x", 10], [":", "y", 20]]]],
            [":", "z", ["object", [":", "a", 10], [":", "b", 20]]],
          ],
        ],
      ],
    ],
  ],
];