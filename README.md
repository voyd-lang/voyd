# Void

Void is a high performance WebAssembly language with an emphasis on full stack web development.

https://justforfunnoreally.dev/

```rust
// Find the value of the fibonacci sequence at index n
fn fib(at n: i32) -> i32
  if n < 2 then:
    n
  else:
    fib(at: n - 1) + fib(at: n - 2)

// All binary programs have a main function
fn main() -> void
  for num in range(15)
    // Call print on the fibonacci sequence at index using UFCS.
    fib(at: num).print()
```

```rust
fn app() -> html
  let todo_items = ["wake up", "eat", "code", "sleep"]
  <div>
    <h1>TODO</h1>
    <ul>
      ${todo_items.map i => <li>${i}</li>}
    </ul>
  </div>
```

**Disclaimer**

Void is in it's very early stages and should not be used for production applications.
Most MVP features have not been implemented yet. The language does run and compile
though. So feel free to play around.

**Features**:

Note: Not all features are complete.

- Functional
- Hybrid Nominal & Structural type system
- Algebraic effects
- First class wasm support
- Macros and language extensions
- Uniform function call syntax
- [Homoiconic](https://en.wikipedia.org/wiki/Homoiconicity)
- Pythonesque syntax that de-sugars into a lisp like dialect
  - Parenthesis can be elided in most cases
  - Infix notation and standard function call notation support

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

**Requirements**

Currently requires node v22 nightly

```
fnm --node-dist-mirror https://nodejs.org/download/nightly install v22
```

# Overview

## Comments

```rust
// Comments are single line and are marked with a c style slash slash
```

## Primitive Types

```rust
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

```rust
// Immutable variable
let my_immutable_var = 7

// Mutable variable
var my_var = 7
```

## Functions

A Basic function:

```rust
fn add(a: i32, b: i32) -> i32
  a + b
```

In most cases the return type can be inferred

```rust
fn add(a:i32, b:i32) = a + b // The equal sign is used when the function is written on one line
```

To call a function, use the function name followed by the arguments in parenthesis

```
add(a: 1, b: 2)
```

Void has similar function definition semantics to Swift. Arguments are labeled by default. The label also inherits the name of the argument by default. This is useful for readability and self documenting code.

To change the name of the label from the default, specify it before the argument name.

```rust
fn add(this num: i32, to other_num: i32) = num + other_num

add(this: 1, to: 2)
```

You can also omit the label by using an underscore

```rust
fn add(_ num: i32, _ other_num: i32) = num + other_num

add(1, 2)
```

Arguments named `self` never have a label

```rust
fn add(self: i32, to num: i32) = self + to

add(1, to: 2)
```

This makes another feature of Void much more convenient, Uniform Function Call Syntax (UFCS). When the first argument of a function is not labeled, the function can be called on the first argument using dot notation.

```rust
fn add(self: i32, to num: i32) = self + num

1.add(to: 2)
```

One final neat feature of functions in Void is that they can be called without parenthesis. This is useful for creating DSLs and for supporting a more natural language like syntax.

```rust
fn walk(from: Point, to: Point) = // ...

walk from: home to: school
```

A function can only be called without parenthesis when they are not an argument to another function*.

* This is a simplification, the actual rules are a bit more complex. But its all you
need to know in order to use the feature.

## Control flow

### If statements

```rust
if 3 < val then:
  "hello" // true case
else:
  "bye" // false case (optional)
```

Ifs are expressions that return a value

```rust
let x = if 3 < val then: "hello" else: "bye"
```

### Loops

Basic loops repeat until returned from

```rust
var a = 0
loop
  if a > 10
    return a
  a += 1
```

Loops can be labeled

```rust
var a = 0
loop name: "increment"
  if a > 10
    return_from "increment" a
  a += 1
```

Useful constructs from looping through iterables

```rust
for item in iterable
  print item
```

### Match Statements

```rust
let x = 3
match x
  1 => print "One"
  2 => print "Two"
  3 => print "Three"
  _ =>
    // Match statements are exhaustive, they must cover every possible
    // case. When not every case is covered, a default handler must be
    // provided.
    write "A number"
```

## Closures

```rust
let double = n => n * 2

array.map n => n * 2
```

## Dot Notation

The dot is a simple form of syntactic sugar

```rust
let x = 4

x.squared

// Translates to
squared(x)
```

## Generics

```rust
fn add[T](a: T, b: T) -> T
  a + b
```

With trait constraints

```rust
fn add[T impls Numeric](a: T, b: T) -> T
  a + b
```
