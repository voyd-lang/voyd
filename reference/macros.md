# Macros

There are three types of macros in void, reader macros, regular macros, and
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

```void
macro def-wasm-operator(op wasm-fn arg-type return-type)
	defun $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator('<' lt_s i32 i32)

// Expands into
defun '<'(left:i32 right:i32) -> i32
	binaryen-mod (i32 lt_s) (left right)
```

# Quotes

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

Void follows the suggestion of this website and pairs commas with the outermost
backquote. Which allows one to use a backquote where a quote would normally be
needed.

# Macro Input

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
