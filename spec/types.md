# Types

## Define Type

`define type` Defines a new type,

### Expanded Meta Syntax

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

## Type Parameters

### Syntax

```ebnf

```
