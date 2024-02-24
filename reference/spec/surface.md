# The Surface Language Specification

This specification defines the language users write, the "surface" void
language.

This surface language spec includes:

-   The surface grammar
-   The surface syntax
-   Macros
-   A standard library (Built in macros, types, and functions)
-   More?

# Language Features

### Examples


### Parenthetical Elision

When a function call is isolated on its own line, the parenthesis can be elided.

Dream uses significant indentation like
[sweet](https://dwheeler.com/readable/sweet-expressions.html). So the
parenthesis can be omitted provided its the only expression on it's line and is
properly indented

TODO: Fill this section out

## Objects

### Object Type

```void
// Definition
obj Pos
	x: i32
	y: i32
	z: i32

// Usage
let my-pos = Pos { x: 5, y: 4, z: 3 }
```

### Object With Methods

```
obj Point2D
	x: Int
	y: Int

impl Point2D
	fn toTuple() -> [Int, Int]
		[self.x, self.y] // self is optional, x and y can be implicitly understood to be referencing self
```

# The Surface Language Grammar

```ebnf
(* Whitespace (Significant to the surface level language) *)
Whitespace = Space | Tab | Newline
Space = " ";
Tab = "\t";
NewLine = "\n";
BackSlash = "\\"; // Single back slash character \

(* Comment *)
Comment = "//", { AnyChar - NewLine }, NewLine;

(* Brackets *)
Bracket = "{" | "}" | "[" | "]" | "(" | ")";

(* Operator Characters (does not imply infix, prefix, or postfix) *)
OpChar = "+" | "-" | "*" | "/" | "=" | ":" | "?" | "." | ";" | "<" | ">" | "$" | "!" | "@" | "%" | "^" | "&" | "~" | BackSlash;
Operator = (OpChar, { OpChar });

(* Terminators *)
Terminator = Bracket | Whitespace | TerminatingOperator | Quote | ",";
Quote = '"' | "'" | "`";
TerminatingOperator = (":" | "?" | "!" | "." | ";" | BackSlash), { OpChar } ;

(* Identifier *)
Identifier = StandardIdentifier | QuotedIdentifier | SharpIdentifier;
StandardIdentifier =  (AnyChar - (Number | Terminator)), { AnyChar - Terminator };
QuotedIdentifier = "'", { AnyChar - "'" }, "'";
SharpIdentifier = "#", AnyChar - Whitespace, { AnyChar - Whitespace };

(* Numbers *)
Number = ScientificNumber | Int | Float;
ScientificNumber = #'^[+-]?\d(\.\d+)?[Ee][+-]?\d+$';
Int = #'^[+-]?\d+$';
Float = #'^[+-]?\d+\.\d+$';

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

At its core, the surface language is still very lisp like. As in lisp,
everything built on a list. Any valid s-expression, is a valid Surface Language
Expression

## Parenthetical Elision

Void language is built around an s-expression syntax, like lisp:

```void
(if (n < 2)
	(: then n)
	(: else (+ (fib (- n 1)) (fib (- n 2)))))
```

To reduce visual noise, parenthesis can be elided, using tabs as a mechanism to
infer where the parenthesis should be inserted:

```void
if (n < 2)
	then: n
	else: (+ (fib (- n 1)) (fib (- n 2)))
```

This feature is inspired by [Scheme
sweet-expressions](https://srfi.schemers.org/srfi-110/)

### Rules

1.  Any line with more than one symbol is wrapped in parenthesis.

    ```void
    add 1 2

    // Becomes
    (add 1 2)
    ```

2.  Indented lines are grouped together in a block and passed to their parent
    function call, provided the fist line is not a named argument.

    ```void
    add 2
    	let x = 5
    	mul 4 x

    // Becomes
    (add 2
    	(block
    		(let (= x 5))
    		(mul 4 x)))
    ```

3.  Isolated labeled arguments, that is labeled arguments that are on their own
    line, are applied to the preceding function call provided:

    1. There are no empty lines separating the two
    2. The labeled argument is on the same indentation level, or 1 child
       indentation level as the preceding function call.

    ```
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

4.  (New) Greedy operators (`=`, `=>`, `|>`, `<|`, `;` `|`) get special
    handling.

    1.  Greedy operators consume indented child blocks, rather than the parent
        function call

        ```
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

    2.  If an expression follows a greedy operator on the same line, a new line
        is inserted after the operator and each child line has an additional
        level of indentation supplied.

            ```
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

5. Parenthetical elision is disabled on any lines surrounded by parenthesis 1.
	Parenthetical elision can be re-enabled by using the whitespace curly block
	`${}` syntax

		``` add(x, y, ${ if x > y then: 3 else: 5 })


		// Becomes (add x y (block (if (> x y) (: then 3) (: else 5)))) ```


Examples:

```
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
```

## Standard Function Call Syntax

To make Void language feel more familiar to users familiar with C style
languages, Void supports standard function call syntax of the form `f(x)`.

### Rules

1.  Any identifier placed directly next to a list is inserted as the first
    argument of that list

```
add(1 2)

// Becomes
(add 1 2)

// Whitespace cancels this affect
add (1 2)

// Becomes
(add (1 2))
```

## Uniform Function Call Syntax (Dot Notation)

The dot (or period) operator applies the expression on the left as an argument
of the expression on the right.

```
5.add(1)

// Becomes
add(5 1)

// Parenthesis on the right expression are not required when the function only takes one argument
5.squared

// Becomes
squared(5)
```

## Labeled Argument Lambda Syntax

Labeled arguments have syntactic sugar that make passing lambda's much cleaner.

When the left hand side of the `:` operator is a list, the first identifier in
that list is treated as the name, additional identifiers become parameters.

```
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

```
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

## Function Overloading

Void functions can be overloaded. Provided that function overload can be
unambiguously distinguished via their parameters and return type.

```void
fn sum(a: i32, b: i32)
	print("Def 1")
	a + b

fn sum(vec: {a:i32, b: i32})
	print("Def 2")
	vec.a + vec.b

sum a: 1, b: 2 // Def 1
sum { a: 1, b: 2 } // Def 2

// ERROR: sum(numbers: ...Int) overlaps ambiguously with sum(a: Int, b: Int)
fn sum(numbers: ...Int)
	print("Def 3")
```

This can be especially useful for overloading operators to support a custom
type:

```
fn '+'(a: Vec3, b: Vec3) -> Vec3
	Vec3(a.x + b.x, a.y + b.y, a.z + b.z)

Vec3(1, 2, 3) + Vec3(4, 5, 6) // Vec3(5, 7, 9)
```

### Rules

-   A function signature is:
-   Its identifier
-   Its parameters, their name, types, order, and label (if applicable)
-   Each full function signature must be unique in a given scope
-   TBD...

## Infix Notation

Void supports infix notation using a predefined set of infix operators.

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

### Rules

-   The infix operator must be surrounded by whitespace to be interpreted as an
    infix operation
-   If the infix operator is the first identifier in a list, s-expression syntax
    is used instead
-   Infix operators should use the same precedence and associative rules as
    JavaScript

## Terminal Identifier

Terminal identifiers do not need to be separated by a whitespace from other
identifiers.

They are any list of OpChars (see grammar) that start with one of the following
OpChars:

-   `.`, `:`, `;`, `?`, `\`, `!`, `&`, `|`

Note: Being a terminal operator does not imply infix

## The Syntax Pipeline

In the spirit of lisp, Void language is designed to be hackable. As a result,
the surface language syntax is implemented entirely in macros. This makes the
language both easy to maintain, and easy to extend.

There are three types of macros:

-   Reader Macros: Expanded during parsing, emit am ast
-   Syntax Macros: Expanded after parsing, are passed the ast from the parser
    and produce the final ast
-   Regular Macros: Expanded by a syntax macro

At a high level, the pipeline looks something like this: `file.void -> parser +
reader macros -> syntax macros -> ast (the core language)`

In the next sections, the different macros will be defined in depth.

### Reader Macros

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

### Syntax Macros

Syntax Macros are responsible for transforming the ast produced by the parser
into the core language ast. Each syntax macro is passed a full copy of the AST.
These macros are strictly run in order. The output of the final syntax macro
must strictly adhere to the core language specification.

Syntax Macro Pipeline Example:

```void
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

### Regular Macros

These are the macros most users will interact with and define the bulk of the
language. They are called in the language exactly like a normal function and
return an expression.

In general, user macros can return any valid surface language expression.
Surface Language implementation macros should either directly return a core
language expression or return an expression that can be converted to a core
language expression further down the syntax macro pipeline.

```

```

# Examples

```void
// Translated version of a swift example from https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/

let photos = await taskGroup(of: Optional(Data).self) | () =>
	let photoNames = await listPhotos(inGallery: "Summer Vacation")

	for name in photoNames
		group.addTaskUnlessCancelled (isCancelled) =>
			if not(isCancelled)
				await downloadPhoto(named: name)

	await group.filter() | (photo) => photo != nil

photos.map name =>
	let photo = await downloadPhoto(named: name)
	photo.map(processPhoto)
```
