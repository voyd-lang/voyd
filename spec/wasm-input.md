# Wasm Input

The wasm code generator accepts a very low level input. Macros
gradually transform the syntax into this lowest level representation.

## Expanded Meta Syntax

```lisp
((define-function $form)*)
```
