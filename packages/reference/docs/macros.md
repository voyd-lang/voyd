---
order: 100
---

# Macros

There are three types of macros in voyd, reader macros, functional macros, and
syntax macros. All macros are expected to return a syntax object.

Reader macros are used to transform the source code while it is being parsed.
They are fed the source code as a stream of tokens.

Syntax macros are used to transform the syntax tree after it has been parsed but
before it is type checked. They are fed the entire syntax tree.

Functional macros are called like functions directly in the source code. They are
fed the syntax object of their arguments.

# Functional Macros

The `macro` macro is designed to make defining simple expansion macros easy and
with minimal boiler plate. Functional work like normal functions, but are only
evaluated at compile time and always return a syntax template.

Functional macros operate directly on the AST.

Syntax templates can be constructed with the backtick (\`). Any identifier
prefixed with `$` will be evaluated when the macro is called and replaced
with it's value.


```voyd
macro def_wasm_operator(op, wasm_fn, arg_type, return_type)
  ` fn $op(left: $arg_type, right: $arg_type) -> $return_type
    binaryen_mod ($arg_type, $wasm_fn) (left, right)

def_wasm_operator('<', lt_s, i32, i32)

// Expands into
fn '<'(left: i32, right: i32) -> i32
  binaryen_mod (i32, lt_s) (left, right)
```

You can also use the `$$` prefix to splice a list in place:

```voyd
macro foo(foo_call)
  let args = foo_call.slice(1)
  if foo_call.get(0) == bar:
    ` you_chose_bar($$args)
  else:
    ` you_chose_something_else($$args)

foo bar(1, 2, 3) // or foo(bar(1, 2, 3))

// Turns into
you_chose_bar(1, 2, 3)
```

You can also use `$` and `$$` to evaluate and insert expressions. Just
call them like a function with a single parameter:

```voyd
macro foo(foo_call)
  if foo_call.get(0) == bar:
    ` you_chose_bar($$(foo_call.slice(1) ))
  else:
    ` unknown_function_name($(foo_call.get(0)))

foo baz(1, 2, 3) // or foo(bar(1, 2, 3))

// Turns into
unknown_function_name(baz)
```

(For lisp users)
Syntax templates work similarly to backquotes. The `$` acts as the `,` in
common lisp and the `$$` acts as the `,@`.


# Outdated info below

## Macro Input

Standard macros receive their arguments in standard S-Expression format. Each supplied argument
is a syntax object that is either a symbol or a list:

```ts
type Symbol = string | number;
type List = Symbol[];
```

# Syntax Objects

TODO

# Syntax Contracts

Type checking for macros. Enforces the structure for inputs and outputs of
macros.

TODO

# Advanced

## Reader Macros

Reader macros are effectively extensions of the parser. They take over parsing
for anything more complex than identifying tokens and producing a tree from
`(nested (lisp like function calls))`.

Each time the parser encounters a token, it will match that token against all
registered reader macros. If a reader macro exists for that token, the file
stream is passed to the reader macro. The macro then consumes the characters off
of this stream at its own discretion. Once finished, it returns a partial ast of
the same type that the parser returns. Once the macro returns, the parser will
insert the result at its current location within the AST and continue on.

User defined reader macros should always begin with a `#`. As of writing, this
is by convention and not enforced in the compiler. It may be enforced at a later
date.

## Syntax Macros

Syntax Macros are responsible for transforming the ast produced by the parser
into the core language ast. Each syntax macro is passed a full copy of the AST.
These macros are strictly run in order. The output of the final syntax macro
must strictly adhere to the core language specification.

Syntax Macro Pipeline Example:

```voyd
fn fib(n:i32) -> i32
  if (n < 2)
    then: n
    else: fib(n - 1) + fib(n - 2)

// After function notation syntax macro
fn (fib n:i32) -> i32
  if (n < 2)
    then: n
    else: (fib n - 1) + (fib n - 2)

// After parenthetical elision syntax macro
(fn (fib n:i32) -> i32
  (if (n < 2)
    (then: n)
    (else: (fib n - 1) + (fib n - 2))))

// After infix notation syntax macro (-> is not an operator)
(fn (fib (: n i32)) -> i32
  (if (< n 2)
    (: then n)
    (: else (+ (fib (- n 1)) (fib (- n 2))))))
```

## The Macro Pipeline

In the spirit of lisp, Voyd language is designed to be hackable. As a result,
the surface language syntax is implemented entirely in macros. This makes the
language both easy to maintain, and easy to extend.

There are three types of macros:

-   Reader Macros: Expanded during parsing, emit am ast
-   Syntax Macros: Expanded after parsing, are passed the ast from the parser
  and produce the final ast
-   Functional Macros: Expanded by a syntax macro

At a high level, the pipeline looks something like this: `file.voyd -> parser +
reader macros -> syntax macros -> ast (the core language)`
