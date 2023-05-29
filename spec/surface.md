# The Surface Language Specification

This specification defines the language users write, the "surface" void language.

This surface language spec includes:

- The surface grammar
- The surface syntax
- Macros
- A standard library (Built in macros, types, and functions)
- More?

# Basic Language Features

## Variables

```void
// Declare an immutable variable
let x = 5

// Declare a mutable variable
var y = 3
```

## String Literals

```void
// Standard
"i can be manipulated and printed and am not evaluated as an atom"

// Strings support newlines
"
I am a big string with new lines
Hey!
"

// Strings support interpolation
"1 + 1 is ${1 + 1}"
```

## Structs

### Struct Type

```void
// Definition
type Pos = {
	x:i32,
	y:i32,
	z:i32
}

// Usage
let my-pos = Pos { x: 5, y: 4, z: 3 }
```

### Struct literal

```void
let value = {
	a: 5,
	b: 4
}
```

## Quote

Note: Unlike common lisp, the single quote is not a macro for `quote`. Only the backtick.

> Second, one might wonder what happens if a backquote expression occurs inside another backquote. The answer is that the backquote becomes essentially unreadable and unwriteable; using nested backquote is usually a tedious debugging exercise. The reason, in my not-so-humble opinion, is that backquote is defined wrong. A comma pairs up with the innermost backquote when the default should be that it pairs up with the outermost. But this is not the place for a rant; consult your favorite Lisp reference for the exact behavior of nested backquote plus some examples.
> https://lisp-journey.gitlab.io/blog/common-lisp-macros-by-example-tutorial/

Void follows the suggestion of this website and pairs commas with the outermost backquote. Which allows
one to use a backquote where a quote would normally be needed.

## Macros

### Macro

The `macro` macro is designed to make defining simple expansion macros easy and with minimal
boiler plate. The body of a `macro` is automatically surrounded by a `quote` block. The
`$` acts as the `,` in common lisp and evaluates the expression it prefixes. The `@` acts
as the `,@` in common lisp and splices the list into the current list. Note that these shortcuts
only apply to `macro`, `define-macro` uses the standard operators of common lisp (`,`, `,@`, etc).

TODO: syntax contracts - type checking for macros. Enforces the structure for inputs and outputs of macros.

```rust
macro $macro($params*) $body
```

### Example

```lisp
macro def-wasm-operator(op wasm-fn arg-type return-type)
	defun $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator("<" lt_s i32 i32)
; Expands into
defun "<"(left:i32 right:i32) -> i32
  binaryen-mod (i32 lt_s) (left right)
```

### Modules

```void
use src/lib *** // Import everything from src/lib
use src/lib as my-lib // Import everything as my-lib
use src/lib { my-util-function } // Import my-util-function from src/lib
use src/lib { func-a sub-module: { func-b } } // Import func-a from src/lib and func-b from the submodule in src/lib
use super/helpers { func-a: func-c } // Import func-a as func-c from ../helpers
use dir/helpers { a } // import a from ./helpers
// If the path points to a folder, an index.dm is assumed
use src/folder { b } // Resolves to src/folder/index.dm
use package { pack-func } // Import pack-func from the installed package called package. Note folders take precedent over installed packages
```

# The Surface Language Grammar

```ebnf
(* Whitespace (Significant to the surface level language) *)
Whitespace = Space | Tab | Newline
Space = " ";
Tab = "\t";
NewLine = "\n";

(* Comment *)
Comment = "//", { AnyChar - NewLine }, NewLine;

(* Operators *)
Operator = InfixOperator | GreedyOperator;
InfixOperator = "and" | "or" | "xor" | "+" | "-" | "/" | "*" | "==" | "<" | ">" | ">=" | "<=" | "|>" | "|" | "^" | "%" | "||" | ":" | ".";
GreedyOperator = "=" | "=>" | "<|" | ";";

(* Brackets *)
Bracket = "{" | "}" | "[" | "]" | "(" | ")";

(* Terminators *)
Terminator = Bracket | Whitespace | '"' | "'" | "." | ";" | ":" | ",";

(* Identifier *)
Identifier = ['#'], RegularIdentifier | SuperIdentifier
RegularIdentifier = AlphabeticChar, { AnyChar - Terminator }
SuperIdentifier = "'", { AnyChar - "'" }, "'";

(* Numbers *)
Number = ScientificNumber | Int | Float;
ScientificNumber = #'^[+-]?\d(\.\d+)?[Ee][+-]?\d+$';
Int = #'^[+-]?\d+$';
Float = #'^[+-]?\d+\.\d+$';

(* Characters reserved for future use*)
Reserved = "@" | "&" | "~";

(* A string is a sequence of characters surrounded by double quotes *)
String = '"', { AnyChar - '"' }, '"';

(* Symbol *)
Symbol = Number | Identifier | String | Operator;

(* List *)
List = "(", { Symbol | List }, ")"

(* Other *)
AlphabeticChar = #'[a-zA-Z]'
AnyChar = ? all valid characters (including whitespace) ?;
```

# The Surface Language Syntax

The surface language is a superset of the core language (a minimalistic lisp dialect). Its goal is to balance the power and simplicity of lisp with a more modern python like feel.

On top of the syntax features supported by the core language syntax, the surface language syntax supports:

- Parenthetical ellison via syntactically significant whitespace
- Standard function call syntax `f(x)`
- Uniform function call syntax `hello.world()` -> `world(hello)`
- Infix operators
- Greedy operators
- Macro expansion
- Tuple, Struct, Array, and Dictionary literals etc

At its core, the surface language is still very lisp like. As in lisp, everything built on a list.
Any valid s-expression, is a valid Surface Language Expression

## Parenthetical Elision

Void language is built around an s-expression syntax, like lisp:

```void
(if (n < 2)
  n
  (+ (fib (- n 1)) (fib (- n 2))))
```

To reduce visual noise, parenthesis can be elided, using tabs as a mechanism to infer where the parenthesis should be inserted:

```void
if (n < 2)
	n
	+ (fib (- n 1)) (fib (- n 2))
```

This feature was inspired by [Koka's brace elision](https://koka-lang.github.io/koka/doc/book.html#sec-layout)

### Rules

- Any line with more than one symbol is wrapped with parenthesis (if it does not already have them)

```void
add 1 2

// Becomes
(add 1 2)
```

- Indented lines are assumed to be parameters of the next line above with one less indentation level provided:
  - There are no empty new lines between the child and the parent
  - The parent is not wrapped in parenthesis

```
add 2
	mul 2
		sub 3 1
	mul 4 5

// Becomes
(add 2
	(mul 2
		(sub 3 1))
	(mul 4 5))
```

## Standard Function Call Syntax

To make Void language feel more familiar to users familiar with C style languages, Void supports standard function call syntax of the form `f(x)`.

### Rules

- Any identifier placed directly next to a list is inserted as the first argument of that list

```
add(1 2)

// Becomes
(add 1 2)

// Whitespace cancels this affect
add (1 2)

// Becomes
(add (1 2))
```

## Infix Notation

Void supports infix notation using a predefined set of operators.

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
  ["==", [0, "left"]],
  ["!=", [0, "left"]],
  ["<", [0, "left"]],
  [">", [0, "left"]],
  ["<=", [0, "left"]],
  [">=", [0, "left"]],
  [".", [6, "left"]],
  ["|>", [4, "left"]],
  ["<|", [4, "right"]],
  ["=", [0, "left"]],
  ["+=", [4, "right"]],
  ["-=", [4, "right"]],
  ["*=", [4, "right"]],
  ["/=", [4, "right"]],
  ["=>", [5, "right"]],
  [":", [0, "left"]],
  [";", [4, "left"]],
  ["??", [3, "right"]],
]);
```

Terminal operators:

```typescript
[".", ":", ";"];
```

### Rules

- The infix operator must be surrounded by whitespace to be interpreted as an infix operation
- Terminal operators are _always_ treated as infix operators, even if no whitespace separates them from the expressions they are applied to
- If the infix operator is the first identifier in a list, s-expression syntax is used instead
- Operators should use the same precedence and associative rules as JavaScript

## The Syntax Pipeline

In the spirit of lisp, Void language is designed to be hackable. As a result, the surface language
syntax is implemented entirely in macros. This makes the language both easy to maintain, and easy
to extend.

There are three types of macros:

- Reader Macros: Expanded during parsing, emit am ast
- Syntax Macros: Expanded after parsing, are passed the ast from the parser and produce the final ast
- Regular Macros: Expanded by a syntax macro

At a high level, the pipeline looks something like this:
`file.void -> parser + reader macros -> syntax macros -> ast (the core language)`

In the next sections, the different macros will be defined in depth.

### Reader Macros

Reader macros are effectively extensions of the parser. They take over parsing for anything more complex than identifying tokens and producing a tree from `(nested (lisp like function calls))`.

Each time the parser encounters a token, it will match that token against all registered reader macros. If a reader macro exists for that token, the file stream is passed to the reader macro. The macro then consumes the characters off of this stream at its own discretion. Once finished, it returns a partial ast of the same type that the parser returns. Once the macro returns, the parser will insert the result at its current location within the AST and continue on.

User defined reader macros should always begin with a `#`. As of writing, this is by convention and not enforced in the compiler. It may be enforced at a later date.

### Syntax Macros

Syntax Macros are responsible for transforming the ast produced by the parser into the core language ast. Each syntax macro is passed a full copy of the AST. These macros are strictly run in order. The output of the final syntax macro must strictly adhere to the core language specification.

Syntax Macro Pipeline Example:

```void
fn fib(n:i32) -> i32
    if (n < 2)
        n
        fib(n - 1) + fib(n - 2)

// After function notation syntax macro
fn (fib n:i32) -> i32
	if (n < 2)
		n
		(fib n - 1) + (fib n - 2)

// After parenthetical elision syntax macro
(fn (fib n:i32) -> i32
	(if (n < 2)
		n
		(fib n - 1) + (fib n - 2)))

// After infix notation syntax macro
(fn (-> (fib (: n i32)) i32)
	(if (< n 2)
		n
		(+ (fib (- n 1)) (fib (- n 2)))))
```

### Regular Macros

These are the macros most users will interact with and define the bulk of the language. They are called in the language exactly like a normal function and return an expression.

In general, user macros can return any valid surface language expression. Surface Language implementation macros should either directly return a core language expression or return an expression that can be converted to a core language expression further down the syntax macro pipeline.
