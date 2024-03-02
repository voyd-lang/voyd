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

# Parenthetical Elision

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

This feature is inspired by [Scheme sweet-expressions](https://srfi.schemers.org/srfi-110/)

## Rules

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

# Standard Function Call Syntax

To make Void language feel more familiar to users familiar with C style
languages, Void supports standard function call syntax of the form `f(x)`.

## Rules

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

# Uniform Function Call Syntax (Dot Notation)

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

# Labeled Argument Lambda Syntax

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

# Infix Notation

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
