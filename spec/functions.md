# Functions Spec

## Define Function

The final function definition. This function is as close to the
final representation the AST can get and is interpreted directly
by the code generator. These functions are registered in the
global scope and therefore must each have a unique identifier.

### Expanded Meta Syntax

```lisp
(define-function $identifier
  (parameters ($param $type-id)*)
  (variables ($variable $type-id)*)
  (return-type $type-id)
  $expr)
```

### Examples

```lisp
;; Define a function fib
(define-function fib
  ;; Function parameter list
  (parameters
    ;; Parameter definition
    (n i32))

  (variables)

  (return-type i32)

  (if (< n 2)
    n
    (+ (fib (- n 1))) (fib (- n 2))))
```

## Extern Function

Represents an external function import (a function provided by the host).

### Expanded Meta Syntax

```lisp
(define-extern-function $identifier
  $external-namespace
  (parameters ($param $type-id)*)
  (return-type $type-id))
```

### Examples

```lisp
// Define a function fib
(define-extern-function fib
  // Function parameter list
  (parameters
    // Parameter definition
    (n i32))

  (return-type i32))
```

## Tail Return

Performs a tail return call.

### Expanded Meta Syntax

```lisp
(return-call $fn-identifier $args*)
```
