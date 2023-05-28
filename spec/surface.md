# The Surface Language Specification

This specification defines the language users write, the "surface" void language.

This surface language spec includes:

- The surface grammar
- The surface syntax
- Macros
- A standard library (Built in macros, types, and functions)
- More?

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

### Regular Macros

These are the macros most users will interact with and define the bulk of the language. They are called in the language exactly like a normal function and return an expression.

In general, user macros can return any valid surface language expression. Surface Language implementation macros should either directly return a core language expression or return an expression that can be converted to a core language expression further down the syntax macro pipeline.
