# Functions Spec

# Defun

A complete expanded function definition. The fn macro expands to this value.

## Grammar

```ebnf
Defun = "(" "defun" Identifier TypeParameters Parameters Effects ReturnType Documentation { Block } ")";
Parameters = "(" "parameters"  { Parameter } ")";
Parameter = "(" "parameter" Identifier OptionalType Label ")";
Effects = "(" "effects" { Effect } ")";
Documentation = "(" "documentation" { String } ")";
ReturnType = Type | EmptyList;
Label = Identifier | EmptyList;
```

## Examples

```lisp
;; Define a function fib
(define-function fib
  ;; Function parameter list
  (parameters
    ;; Parameter definition
    (n Int ()))

  (effects)

  Int

  (documentation "returns the value of the fibonacci sequence at the provided index")

  (if (< n 2)
    n
    (+ (fib (- n 1))) (fib (- n 2))))
```

```lisp

```
