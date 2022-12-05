# Macros

## Macro

The `macro` macro is designed to make defining simple expansion macros easy and with minimal
boiler plate. The body of a `macro` is automatically surrounded by a `quote` block. The
`$` acts as the `,` in common lisp and evaluates the expression it prefixes. The `@` acts
as the `,@` in common lisp and splices the list into the current list. Note that these shortcuts
only apply to `macro`, `define-macro` uses the standard operators of common lisp (`,`, `,@`, etc).

TODO: syntax contracts - type checking for macros. Enforces the structure for inputs and outputs of macros.

### Dream Syntax

```rust
macro $fn-name($params*) $body
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
