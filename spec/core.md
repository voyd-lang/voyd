# The Core Language Specification

This specification defines the language targeted by the surface language. After all macros have been evaluated, void source files are transformed into a form compliant with this spec.

# The Core Language Grammar

```ebnf
SExpr = AtomicSymbol | List;

List = OpenBracket SExpr* CloseBracket;

OpenBracket = Empty* "(" Empty*

CloseBracket = Empty* ")" Empty*

AtomicSymbol = !Number (Alphanumeric+ | Empty+);

Alphanumeric = #'[^\s\(\)]';

Number = Int | Float;

Int = #'^[+-]?\d+$';

Float = #'^[+-]?\d+\.\d+$';

Empty = " ";
```

# Basic Language Features

## Cond

Multiple conditions

Syntax:

```lisp
(cond ($condition:Boolean result:Expr)*)
```

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

## Define Function

The final function definition. This function is as close to the
final representation the AST can get and is interpreted directly
by the code generator. These functions are registered in the
global scope and therefore must each have a unique identifier.

```lisp
(define-function $identifier
  (parameters ($name $type-id)*)
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
  (parameters ($name $type-id)*)
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

Defines an immutable global value accessible across function instances

```lisp
(define-global $identifier:String | $labeled-expr:LabeledExpr $expr)
```

## Define Mutable Global

Defines a mutable global value accessible across function instances

```lisp
(define-mut-global $identifier:String | $labeled-expr:LabeledExpr $expr)
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
  ($body*))
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

# Memory Layout

### Stack / Linear Memory

Structs and unboxed types are stored in linear memory using a stack.

Each datum stored on the stack has the following layout:

- Byte 0-3, i32, Size - the size of the datum it represents
- Byte 4-7, i32, Type ID - An ID of the type the datum uses
- Byte 8+, any, The data.

---
