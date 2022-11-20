# Functions Spec

## Define Function

The final function definition. This function is as close to the
final representation the AST can get and is interpreted directly
by the code generator. These functions are registered in the
global scope and therefore must each have a unique identifier.

### Expanded Meta Syntax

```lisp
(define-function $identifier
  (parameters ($param $type)*)
  (variables ($variable $type)*)
  (return-type $type)
  $expr*)
```

### Examples

```lisp
;; Define a function fib
(define-function fib
  ;; Function parameter list
  (parameters
    ;; Parameter definition
    (n Int))

  (variables)

  (return-type Int)

  (if (< n 2)
    n
    (+ (fib (- n 1))) (fib (- n 2))))
```
