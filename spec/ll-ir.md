# Low Level IR

This spec defines the lowest intermediate representation of Dream before it is converted into
WASM / machine code.

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

## Globals

Defines a global value accessible across function instances

```
(global $mutability:(var|let) $name:TypedParameter = $value)
```

## Modules

### Root Module

Type: Root

Syntax:

```lisp
(root $module-id:String $modules:Module*)
```

### Standard Module

Type: Module

Syntax:

```lisp
(module $module-id:String
  (imports ($import-module-id "***")*)
  (exports $exports:Export*)
  (block $body*))
```

Example export `["export", "'<'", ["parameters", ["left", "i32"], ["right", "i32"]]]`

## Types

### Define Type

`define type` Defines a new type,

#### Expanded Meta Syntax

```lisp
(define-type $identifier $type-expr)
```

#### Examples

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

## Type Parameters

## Variables Spec

## Let / Var

```lisp
(define-let $identifier $type-id $expr)
```
