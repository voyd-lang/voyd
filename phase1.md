# Phase 1: Read Time

The reader / parse converts a stream of characters into raw ast output:

```
[
  "\n",
  "fn", " ", ["fib", "n:Int"], " ", "->", " ", "Int", "\n",
  "\t", "if", " ", ["n", " ", "<", " ", "2"], "\n",
  "\t", "\t", "n", "\n",
  "\t", "\t", ["fib", "n", " ", "-", " ", "1"], " ", "+", " ", ["fib", "n", " ", "-", " ", "2"], "\n"
]
```

Note that all whitespace characters are kept. These are handled in
phase 2.
