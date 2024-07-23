export const regularMacrosAst = [
  "module",
  "root",
  [
    [
      "module",
      "test",
      [
        [
          "regular-macro",
          "`#731",
          ["parameters"],
          ["block", ["block", ["quote", "quote", ["$@", "body"]]]],
        ],
        [
          "regular-macro",
          "let#768",
          ["parameters"],
          [
            "block",
            [
              "block",
              ["define", "equals_expr", ["extract", "body", 0]],
              [
                "quote",
                "define",
                ["$", ["extract", "equals_expr", 1]],
                ["$", ["extract", "equals_expr", 2]],
              ],
            ],
          ],
        ],
        [
          "define-macro-variable",
          "extract_parameters",
          ["reserved-for-type"],
          ["is-mutable", false],
        ],
        [
          "regular-macro",
          "fn#1247",
          ["parameters"],
          [
            "block",
            [
              "block",
              ["define", "definitions", ["extract", "body", 0]],
              ["define", "identifier", ["extract", "definitions", 0]],
              ["define", "params", ["extract_parameters", "definitions"]],
              [
                "define",
                "type_arrow_index",
                [
                  "block",
                  [
                    "if",
                    ["==", ["extract", "body", 1], ["string", "->"]],
                    [":", "then", ["block", 1]],
                    [
                      ":",
                      "else",
                      [
                        "block",
                        [
                          "if",
                          ["==", ["extract", "body", 2], ["string", "->"]],
                          [":", "then", 2],
                          [":", "else", -1],
                        ],
                      ],
                    ],
                  ],
                ],
              ],
              [
                "define",
                "return_type",
                [
                  "block",
                  [
                    "if",
                    [">", "type_arrow_index", -1],
                    [
                      ":",
                      "then",
                      [
                        "block",
                        [
                          "slice",
                          "body",
                          ["+", "type_arrow_index", 1],
                          ["+", "type_arrow_index", 2],
                        ],
                      ],
                    ],
                    [":", "else", ["quote"]],
                  ],
                ],
              ],
              [
                "define",
                "expressions",
                [
                  "block",
                  [
                    "if",
                    [">", "type_arrow_index", -1],
                    [
                      ":",
                      "then",
                      [
                        "block",
                        ["slice", "body", ["+", "type_arrow_index", 2]],
                      ],
                    ],
                    [":", "else", ["slice", "body", 1]],
                  ],
                ],
              ],
              [
                "quote",
                "define_function",
                ["$", "identifier"],
                ["$", "params"],
                ["return_type", ["$@", "return_type"]],
                ["$", ["concat", ["quote", "block"], "expressions"]],
              ],
            ],
          ],
        ],
        [
          "define_function",
          "fib",
          ["parameters", [":", "n", "i32"]],
          ["return_type", "i32"],
          [
            "block",
            [
              "block",
              ["define", "base", 1],
              [
                "if",
                ["<=", "n", "base"],
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
        ],
      ],
    ],
  ],
];
