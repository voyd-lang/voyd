# Macros

There are three types of macros in voyd, reader macros, regular macros, and
syntax macros. All macros are expected to return a syntax object.

Reader macros are used to transform the source code while it is being parsed.
They are fed the source code as a stream of tokens.

Syntax macros are used to transform the syntax tree after it has been parsed but
before it is type checked. They are fed the entire syntax tree.

Regular macros are called like functions directly in the source code. They are
fed the syntax object of their arguments.

# Regular Macros

The `macro` macro is designed to make defining simple expansion macros easy and
with minimal boiler plate. The body of a `macro` is automatically surrounded by
a `quote` block. The `$` acts as the `,` in common lisp and evaluates the
expression it prefixes. The `@` acts as the `,@` in common lisp and splices the
list into the current list. Note that these shortcuts only apply to `macro`,
`define-macro` uses the standard operators of common lisp (`,`, `,@`, etc).

```voyd
macro def-wasm-operator(op wasm-fn arg-type return-type)
  defun $op(left:$arg-type right:$arg-type) -> $return-type
    binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator('<' lt_s i32 i32)

// Expands into
defun '<'(left:i32 right:i32) -> i32
  binaryen-mod (i32 lt_s) (left right)
```

## Quotes

Note: Unlike common lisp, the single quote is not a macro for `quote`. Only the
backtick.

> Second, one might wonder what happens if a backquote expression occurs inside
> another backquote. The answer is that the backquote becomes essentially
> unreadable and unwriteable; using nested backquote is usually a tedious
> debugging exercise. The reason, in my not-so-humble opinion, is that backquote
> is defined wrong. A comma pairs up with the innermost backquote when the
> default should be that it pairs up with the outermost. But this is not the
> place for a rant; consult your favorite Lisp reference for the exact behavior
> of nested backquote plus some examples.
> https://lisp-journey.gitlab.io/blog/common-lisp-macros-by-example-tutorial/

Voyd follows the suggestion of this website and pairs commas with the outermost
backquote. Which allows one to use a backquote where a quote would normally be
needed.

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
-   Regular Macros: Expanded by a syntax macro

At a high level, the pipeline looks something like this: `file.voyd -> parser +
reader macros -> syntax macros -> ast (the core language)`
