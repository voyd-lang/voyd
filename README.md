# Void

Void is a high performance WebAssembly language with an emphasis on full stack web development.

https://justforfunnoreally.dev/

```swift
// Find the value of the fibonacci sequence at index n
fn fib(n:i32) -> i32
    if (n < 2)
        n
        fib(n - 1) + fib(n - 2)

// All binary programs have a main function (NOTE: for in syntax shown below not yet supported)
fn main() -> void
    var index = 0
    for num in range(15)
        // Print fibonacci sequence at index using UFCS.
        num.fib().print()
```

**Disclaimer**

Void is in it's very early stages and should not be used for production applications.
Most MVP features have not been implemented yet. The language does run and compile
though. So feel free to play around.

**Features**:

Note: Not all features are complete.

- Functional
- Strongly Typed
- First class wasm support
- Memory Safe GC
- Algebraic data types
- Algebraic effects
- Macros and language extensions
- [Homoiconic](https://en.wikipedia.org/wiki/Homoiconicity)
- Pythonesque syntax that de-sugars into a lisp like dialect
  - Parenthesis can be elided in most cases
  - Infix notation and standard function call notation support
- Uniform function call syntax

**Guiding Principles**:

- Fun to write _and_ read.
- Predictability
- Hackability
- Balance a great developer experience with performance
- Play nice with others

# Getting Started

**Install**

```
npm i -g voidc
```

**Usage**

```
voidc path/to/code.void
```

# Overview

## Comments

```
// Comments are single line and are marked with a c style slash slash
```

## Primitive Types

```
true // Boolean
false // Boolean
1 // i32 by default (32 bit integer)
1.0 // f32 by default (32 bit float)
"Hello!" // String, can be multiline, supports interpolation via ${}
[1, 2, 3] // Tuple literal
{x: 2, y: 4} // Object literal
#[1, 2, 3] // Array
#{x: 3, y: 4} // Dictionary
```

## Variables

```
// Immutable variable
let my_immutable_var = 7

// Mutable variable
var my_var = 7
```

## Functions

A Basic function:

```
fn add(a: i32 b: i32) -> i32
  a + b
```

In most cases the return type can be inferred

```
fn add(a: i32 b: i32) = a + b // The equal sign is used when the function is written on one line
```

Functions are called using S-expression syntax

```
(add 1 2) // 3
```

Dream uses significant indentation like [sweat](https://dwheeler.com/readable/sweet-expressions.html). So the parenthesis can be omitted provided its the only expression on it's line and is properly indented

```
add 1 2
```

Dream can also call functions in the more standard mathematical notation. Note that there cannot be whitespace separating the function name from the opening parenthesis

```
add(1 2)
```

## Infix Notation

Dream supports infix notation on a fixed list of operators. Infix operators must be separated by whitespace on each side.

Operators include:

- `+`
- `-`
- `*`
- `/`
- `<`
- `>`
- `<=`
- `>=`
- `^`
- `=` Assignment
- `+=` Assignment
- `-=` Assignment
- `*=` Assignment
- `/=` Assignment
- `==` Comparison

## Control flow

### If statements

```
if 3 < val
  "hello" // true case
  "bye" // false case (optional)
```

Ifs are expressions that return a value

```
let x = (if 3 < val "hello" "bye")
```

### Loops

Basic loops repeat until returned from

```
var a = 0
loop
  if a > 10
    return a
  a += 1
```

Loops can be named

```
var a = 0
loop :named increment
  if a > 10
    return_from increment a
  a += 1
```

Useful constructs from looping through iterables

```
for item in iterable
  write item
```

### Match Statements

```
let x = 3
match x
  1 (write "One")
  2 (write "Two")
  3 (write "Three")
  default
    // Match statements are exhaustive, they must cover every possible
    // case. When not every case is covered, a default handler must be
    // provided.
    write "A number"
```

## Lambdas

```
let double = n => n * 2

array.map n => n * 2
```

## Dot Notation

The dot is a simple form of syntactic sugar

```
let x = 4

x.squared

// Translates to
squared x // (squared x)
```

## Keyword Arguments

Any arguments prefixed with ~ are keyword arguments

```
fn move(robot: Robot, ~to: [i32 i32 i32])
  // etc

move robot to: [3.1, 2.3, 4.0]
```

You can also provide an external label to alias the keyword on call.

```
fn add(a:i32, with:b:i32)
  a + b
  html
    ul
      items.each item => (li item)

add 1 with: 4
```

## Generics

```
fn add::(T)(a:T b:T) -> T
  a + b
```

With trait constraints

```
fn add::(T:Numeric)(a:T b:T) -> T
  a + b
```
