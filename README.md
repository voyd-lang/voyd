# Void

Void is a high performance WebAssembly language with an emphasis on full stack web development.

https://justforfunnoreally.dev/

```rust
fn fib(n: i32) -> i32
  if n < 2 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

fn main() -> void
  for n in range(15)
    print fib(n)
```

```tsx
fn app() -> JSX::Element
  let todo_items = ["wake up", "eat", "code", "sleep"]
  <div>
    <h1>TODO</h1>
    <ul>
      {todo_items.map i => <li>{i}</li>}
    </ul>
  </div>
```

**Disclaimer**

Void is in it's very early stages of development. Void is not ready for public
announcement or use. Some core syntax and semantics are subject to change.
Expect frequent breaking changes. In addition, many documented features are not
yet implemented.

**Features**:

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

Currently requires node v22

```bash
# Or nvm
fnm install v22
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
1 // i32 by default
1.0 // f32 by default
"Hello!" // String, can be multiline, supports interpolation via ${}
[1, 2, 3] // Array literal
(1, 2, 3) // Tuple literal
{x: 2, y: 4} // Object literal
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
add(1, 2)
```

Void also supports uniform function call syntax (UFCS), allowing functions to be called on a type as if they were methods of that type.

```rust
1.add(2)
```

### Labeled arguments

Labeled arguments can be defined by wrapping parameters you wish to be labeled
on call in curly braces.

```rust
fn add(a: i32, {to: i32}) = a + to

add(1, to: 2)
```

By default, the argument label is the same as the parameter name. You can
override this by specifying the label before the argument name.

```rust
fn add(a: i32, {to:b: i32}) = a + b

add(1, to: 2)
```

Labeled arguments can be thought of as syntactic sugar for defining a object
type parameter and destructuring it in the function body[1]:

```rust
fn move({ x: i32 y: i32 z: i32 }) -> void
  // ...

// Semantically equivalent to:
fn move(vec: { x: i32 y: i32 z: i32 }) -> void
  let { x, y, z } = vec
  // ...

move(x: 1, y: 2, z: 3)

// Equivalent to:
move({ x: 1, y: 2, z: 3 })
```

This allows you to still use object literal syntax for labeled arguments when
it might be cleaner to do so. For example, when the variable names match the
argument labels:

```rust
let [x, y, z] = [1, 2, 3]

// Object field shorthand allows for this:
move({ x, y, z })

// Which is better than
move(x: x, y: y, z: z)
```

[1] The compiler will typically optimize this away, so there is no performance
penalty for using labeled arguments.


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

Match statements are used for type narrowing

```rust
obj Animal
obj Cat extends Animal
obj Dog extends Animal

let dog = Dog {}

match(dog)
  Dog: print "Woof"
  Cat: print "Meow"
  else:
    print "Blurb"
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
fn add<T>(a: T, b: T) -> T
  a + b
```

With trait constraints

```rust
fn add<T: Numeric>(a: T, b: T) -> T
  a + b
```
