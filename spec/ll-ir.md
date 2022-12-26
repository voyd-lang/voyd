# Low Level IR

This spec defines the lowest intermediate representation of Dream before it is converted into
WASM / machine code.

## BNR

Defines a call to a binaryen function

```lisp
(bnr ($namespace:String $function:String $return-type:String) ($args:Expr*))
```

## Define

`define` defines an immutable variable within a function. Where identifier is a labeled expression where the label is the identifier name and the expr is it's type.

```lisp
(define $identifier:LabeledExpr $expr)
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
  (parameters ($name $type-id $label?)*)
  (variables ($name $type-id)*)
  (return-type $type-id)
  $block:TypedBlock)
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

  (typed-block i32
    (if (< n 2)
      n
      (+ (fib (- n 1))) (fib (- n 2)))))
```

## Define Extern Function

Defines an external function that has been imported into the module via WASM imports or equivalent.

```lisp
(define-extern-function $identifier
  (namespace $name) // TODO: Move to bottom of list for implementation simplicity.
  (parameters ($name $type-id $label?)*)
  (return-type $type-id))
```

### Examples

```lisp
;; Define a function fib
(define-extern-function fib
  (namespace math)
  ;; Function parameter list
  (parameters
    ;; Parameter definition
    (n i32))

  (return-type i32))
```

## Define Global

Defines a global value accessible across function instances

```
(define-global $mutability:(var|let) $name:LabeledExpr = $value)
```

## Define Mut

`define-mut` defines a mutable variable within a function

```lisp
(define-mut $identifier:String | $labeled-expr:LabeledExpr $expr)
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

## Labeled Expr

Defines a labeled expression. These are used to annotate types

```lisp
(labeled-expr $label:String $exp)
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

## Typed Block

A standard block with return type annotations

```lisp
(typed-block $return-type:String $expr:Expr*)
```
