# The Surface Language Syntax

The surface language is a superset of the core language (a minimalistic lisp
dialect). Its goal is to balance the power and simplicity of lisp with a more
modern python like feel.

On top of the syntax features supported by the core language syntax, the surface
language syntax supports:

-   Parenthetical ellison via syntactically significant whitespace
-   Standard function call syntax `f(x)`
-   Uniform function call syntax `hello.world()` -> `world(hello)`
-   Infix operators
-   Greedy identifiers
-   Macro expansion
-   Tuple, Struct, Array, and Dictionary literals etc
-   Clause-style labeled suites (multiline only)
-   Nominal object initialization shorthand (`Type { ... }`)
-   Pattern matching (`match`) and `if`-as-`match` shorthand

At its core, the surface language is still very lisp like. As in lisp,
everything built on a list. Any valid s-expression, is a valid Surface Language
Expression

# Parenthetical Elision

Voyd language is built around an s-expression syntax, like lisp:

```voyd
(if (n < 2)
  (: then n)
  (: else (+ (fib (- n 1)) (fib (- n 2)))))
```

To reduce visual noise, parenthesis can be elided, using tabs as a mechanism to
infer where the parenthesis should be inserted:

```voyd
if (n < 2)
  then: n
  else: (+ (fib (- n 1)) (fib (- n 2)))
```

This feature is inspired by [Scheme sweet-expressions](https://srfi.schemers.org/srfi-110/)

## Rules

1.  Any line with more than one symbol is wrapped in parenthesis.

  ```voyd
  add 1 2

  // Becomes
  (add 1 2)
  ```

2.  Indented lines are grouped together in a block and passed to their parent
  expression.

  ```voyd
  add 2
    let x = 5
    mul 4 x

  // Becomes
  (add 2
    (block
      (let (= x 5))
      (mul 4 x)))
  ```

  If an indented suite contains only argument-like entries (labeled arguments),
  the suite is treated as additional arguments rather than a `block(...)`.

  ```voyd
  match(x)
    Some: 1
    None: 0

  // Becomes (conceptually)
  (match x
    (: Some 1)
    (: None 0))
  ```

3.  Isolated labeled arguments, that is labeled arguments that are on their own
  line, are applied to the preceding function call provided:

  1. There are no empty lines separating the two
  2. The labeled argument is on the same indentation level, or 1 child
     indentation level as the preceding function call.

  ```voyd
  if x > y then: 3
  else: 5

  // Becomes
  (if (> x y)
    (: then 3)
    (: else 5))

  // Another example
  if x > y
    then: 3
    else: 5

  // Becomes
  (if (x > y)
    (: then 3)
    (: else 5))
  ```

4.  Clause-style labeled suite sugar (multiline only).

  This is a general mechanism used to make “conditional clause” syntax feel
  more natural while still being a uniform call + labeled-args language.

  If a call has already established a “suite label” that takes an indented
  suite (e.g. `then:`), then subsequent clauses can be written as:

  ```voyd
  label <expr>:
    <suite>
  ```

  and desugar into:

  ```voyd
  label: <expr>
  <suite_label>:
    <suite>
  ```

  Example (`if`):

  ```voyd
  if x < 1 then:
    10
  elif x < 2:
    20
  else:
    30

  // Becomes (conceptually)
  (if (< x 1)
    (: then (block 10))
    (: elif (< x 2))
    (: then (block 20))
    (: else (block 30)))
  ```

  Notes:

  - Clause-style sugar is intentionally **disallowed on one-liners** to keep
    parsing predictable.
  - To avoid ambiguity with type annotations / assignments (e.g. `let x: T = 1`)
    the clause condition portion rejects assignment-like operators (`=`, `:=`)
    at the same list level.

4.  Greedy operators (`=`, `=>`, `|>`, `<|`, `;` `|`) get special
  handling.

  1.  Greedy operators consume indented child blocks, rather than the parent function call

    ```voyd
    let x =
      if (x > y)
        then: 3
        else: 5

    // Becomes
    (let (= x
      (block
        (if (> x y)
        (: then 3)
        (: else 5)))))
    ```

  2. If an expression follows a greedy operator on the same line, a new line is inserted after the operator and each child line has an additional level of indentation supplied.

      ```voyd
      let z = if x > y
        then: 3
        else: 5

      // Becomes
      let z =
        if x > y
          then: 3
          else: 5

      // Which in turn becomes
      (let (=
        z
        (block
          (if
            (> z y)
              (: then 3)
              (: else 5)))))
      ```

5. Arguments already wrapped in parenthesis must be separated by a comma

  ```voyd
  add(1, 2)

  // Becomes
  (add 1 2)

  add(sub 1 2, 3)

  // Becomes
  (add (sub 1 2) 3)
  ```


Examples:

```voyd
if x > 3 then:
  do_work()
  blah()
else:
  do_other_work()

// Becomes
(if (> x 3)
  (: then (block
    do_work()
    blah()))
  (: else (block
    do_other_work())))

obj Pos
  x: (if x > 3 then: b else: c)
  y: 2
  z: 3

// Becomes
(obj Pos
  (: x (if (> x 3)
    (: then b)
    (: else c)))
  (: y 2)
  (: z 3))

obj Pos
x: 1
y: 2
z: 3

// Becomes
(obj Pos
  (: x 1)
  (: y 2)
  (: z 3))

let x = my_func(
  add 1 2,
  () =>
    hello(),
  3 + 4,
)

// Becomes
(let
  (=
  x
  (my_func
    (add 1 2)
    (=> () (block (hello)))
    (+ 3 4))))
```

# Nominal Object Initialization Shorthand

Direct object initialization uses an object literal following a type name:

```voyd
MyObj { field: 1 }
```

In the surface language, an `UpperCamelCase` identifier (or `module::UpperCamelCase`
path) followed immediately by an object literal is treated as a *single*
constructor-init expression. This fixes cases like:

```voyd
return MyObj { field: 1 }
```

which should be interpreted as:

```voyd
return(MyObj({ field: 1 }))
```

This also works with:

-   Generics: `MyObj<i32> { field: 1 }`
-   Deep module paths: `outer::inner::MyObj { field: 1 }`

If you need to pass the type and the object literal as separate arguments, wrap
the type in parentheses to disable the constructor-init merge:

```voyd
my_two_arg_call (MyObj) { field: 1 }
```

# Standard Function Call Syntax

To make Voyd language feel more familiar to users familiar with C style
languages, Voyd supports standard function call syntax of the form `f(x)`.

## Rules

1.  Any identifier placed directly next to a list is inserted as the first
  argument of that list

```voyd
add(1 2)

// Becomes
(add 1 2)

// Whitespace cancels this affect
add (1 2)

// Becomes
(add (1 2))
```

# Pattern Matching (`match`)

`match` is an expression that branches on a value using pattern arms:

```voyd
match(pet)
  Dog as d: d.noses + 1
  Cat as c: c.lives
  else: 0
```

Arms are written as `pattern: expr` (or `pattern:` followed by an indented
suite, which becomes `pattern: block(...)`).

## Patterns

Current pattern forms include:

-   **Wildcard**: `else` (or `_` in binding positions).
-   **Type check**: `Dog`
-   **Type + bind whole value**: `Dog as d`
-   **Type + destructure fields**:

  ```voyd
  (Dog { noses }): noses + 1
  (Cat { lives: l }): l
  ```

-   **Tuple patterns**:

  ```voyd
  (a, b): a + b
  ```

-   **Nested patterns**:

  ```voyd
  (Some { v: (a, b) }): a * 10 + b
  ```

# `if` as `match` Shorthand

An `if/elif/else` chain is lowered as a `match` when all conditions are simple
type tests of the same identifier and an `else` branch exists:

```voyd
if pet is Dog then:
  pet.noses
elif pet is Cat:
  pet.lives
else:
  0
```

This is equivalent to a `match(pet)` with type patterns plus a wildcard arm.

# Uniform Function Call Syntax (Dot Notation)

The dot (or period) operator applies the expression on the left as an argument
of the expression on the right.

```voyd
5.add(1)

// Becomes
add(5 1)

// Parenthesis on the right expression are not required when the function only takes one argument
5.squared

// Becomes
squared(5)
```

# Labeled Argument Lambda Syntax

Labeled arguments have syntactic sugar that make passing lambda's much cleaner.

When the left hand side of the `:` operator is a list, the first identifier in
that list is treated as the name, additional identifiers become parameters.

```voyd
fn call(cb: fn(v: i32) -> void)
  cb(5)

call cb(v):
  print(v)

// Equivalent to
call cb: (v) =>
  print
```

This works nicely with the rules of labeled arguments to support a trailing
lambda syntax similar to that of swift or koka.

```voyd
try this():
  this_throws_an_error()
catch(e):
  print(e)

// Becomes
(try
  (: this (lambda () (block (this_throws_an_error))))
  (: catch (lambda (e) (block
    print(e)))))
```

# Infix Notation

Voyd supports infix notation using a predefined set of infix operators.

Operators, their precedence, and associativity (in typescript):

```typescript
/** Key is the operator, value is its [precedence, associativity] */
export const infixOperators = new Map<string, [number, Associativity]>([
  ["+", [1, "left"]],
  ["-", [1, "left"]],
  ["*", [2, "left"]],
  ["/", [2, "left"]],
  ["and", [0, "left"]],
  ["or", [0, "left"]],
  ["xor", [0, "left"]],
  ["as", [0, "left"]],
  ["is", [0, "left"]],
  ["in", [0, "left"]],
  ["==", [0, "left"]],
  ["!=", [0, "left"]],
  ["<", [0, "left"]],
  [">", [0, "left"]],
  ["<=", [0, "left"]],
  [">=", [0, "left"]],
  [".", [6, "left"]],
  ["|>", [4, "left"]],
  ["<|", [4, "right"]],
  ["|", [4, "right"]],
  ["=", [0, "left"]],
  ["+=", [4, "right"]],
  ["-=", [4, "right"]],
  ["*=", [4, "right"]],
  ["/=", [4, "right"]],
  ["=>", [5, "right"]],
  [":", [0, "left"]],
  ["::", [0, "left"]],
  [";", [4, "left"]],
  ["??", [3, "right"]],
  ["?:", [3, "right"]],
]);
```

## Rules

-   The infix operator must be surrounded by whitespace to be interpreted as an
  infix operation
-   If the infix operator is the first identifier in a list, s-expression syntax
  is used instead
-   Infix operators should use the same precedence and associative rules as
  JavaScript

# Terminal Identifier

Terminal identifiers do not need to be separated by a whitespace from other
identifiers.

They are any list of OpChars (see grammar) that start with one of the following
OpChars:

-   `.`, `:`, `;`, `?`, `\`, `!`, `&`, `|`

Note: Being a terminal operator does not imply infix
