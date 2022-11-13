# Phase 2: Macro Expansion

This phase pipes the AST through the macro pipeline.

Phase 2 itself has 3 phases:

1. Pipe AST through default and plugin AST Macros
2. Scan transformed AST for source macros, remove them from ast and add to macro table
3. Match ast through macro table

## Default AST Macro Pipeline

AST Macros take the entire AST and return a transformed copy of the AST

### Parenthetical Elision

Transforms syntactically significant whitespace into lists:

```
[
  "\n",
  "fn", " ", ["fib", "n:Int"], " ", "->", " ", "Int", "\n",
  "\t", "if", " ", ["n", " ", "<", " ", "2"], "\n",
  "\t", "\t", "n", "\n",
  "\t", "\t", ["fib", "n", " ", "-", " ", "1"], " ", "+", " ", ["fib", "n", " ", "-", " ", "2"], "\n"
]
```

Transformed into

```
[
  ["fn", ["fib", "n:Int"], "->", "Int",
    ["if", ["n", "<", "2"],
      ["n"],
      [["fib", "n", "-", "1"], "+", ["fib", "n", "-", "2"]]]
]
```

All whitespace strings are removed during this phase

Note to self: Consider moving standard function notation transformation
to this step.

### Infix

Infix operators are converted to prefix notation.

Standard infix operators are `+`, `-`, `*`, `/`, `=`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `=>`, `|>`, `+=`, `-=`, `*=`, `/=`, `and`, `or`, and `xor`.

```
[
  ["fn", ["fib", "n:Int"], "->", "Int",
    ["if", ["n", "<", "2"],
      ["n"],
      [["fib", "n", "-", "1"], "+", ["fib", "n", "-", "2"]]]
]
```

Transforms into:

```
[
  ["fn", ["fib", "n:Int"], "->", "Int",
    ["if", ["<", "n", "2"],
      ["n"],
      ["+", ["fib", ["-", "n", "1"]], ["fib", ["-", "n", "2"]]]]
]
```
