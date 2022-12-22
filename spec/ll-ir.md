# Low Level IR

This spec defines the lowest intermediate representation of Dream before it is converted into
WASM / machine code.

## Define

`define` defines an immutable variable within a function

```lisp
(define $identifier:String | $typed-identifier:TypedIdentifier $expr)
```

## Define CDT

Defines a complex data type I.E. tuple / struct

```lisp
(define-cdt $name:String $type-id:i32 $size:i32)
```

## Define Function

The final function definition. This function is as close to the
final representation the AST can get and is interpreted directly
by the code generator. These functions are registered in the
global scope and therefore must each have a unique identifier.

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

## Define Global

Defines a global value accessible across function instances

```
(define-global $mutability:(var|let) $name:TypedParameter = $value)
```

## Define Mut

`define-mut` defines a mutable variable within a function

```lisp
(define-mut $identifier:String | $typed-identifier:TypedIdentifier $expr)
```

## Define Type

`define type` Defines a new type,

```lisp
(define-type $identifier $type-expr)
```

### Examples

Define `Int` as an alias to i32

```lisp
(define-type Int i32)
```

Define `ArrayInt` as an array of integers

```lisp
(define-type ArrayInt (Array Int))
```

Define AsyncNumericOp as an asynchronous function that accepts a number and returns a number

```lisp
(define-type AsyncNumericOp
  (Function
    (type-parameters)
    (parameters (n Int ()))
    (effects Async)
    (return-type Int)))
```

## Extern Function

Represents an external function import (a function provided by the host).

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

## Module

Type: Module

```lisp
(module $module-id:String
  (imports ($import-module-id "***")*)
  (exports $exports:Export*)
  (block $body*))
```

Example export `["export", "'<'", ["parameters", ["left", "i32"], ["right", "i32"]]]`

## Tail Return

Performs a tail return call.

```lisp
(return-call $fn-identifier $args*)
```

## Root Module

Type: Root

```lisp
(root $module-id:String $modules:Module*)
```
