# Types

## Define Type

`define type` Defines a new type,

### Grammar

```ebnf
DefineType = "(" "define-type" Identifier TypeExpr ")";
```

### Examples

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

### Grammar

```ebnf

```
