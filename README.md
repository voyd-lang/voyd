# Voyd

Voyd is a high performance WebAssembly language with an emphasis on full stack web development.

https://justforfunnoreally.dev/

```rust
fn fib(n: i32) -> i32
  if n < 2 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main()
  fib(10)
```

**Disclaimer**

Voyd is in it's very early stages of development. Voyd is not ready for public
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

**Guiding Principles**:

- Fun to write _and_ read.
- Predictability
- Hackability
- Balance a great developer experience with performance
- Play nice with others

# Getting Started

**Install**

```bash
npm i -g voyd
```

**Usage Examples**

```bash
# Run the exported main function
voyd --run script.void

# Compile a directory (containing an index.void) to webassembly
voyd --emit-wasm src > output.wasm

# Compile a to optimized WebAssembly
voyd --emit-wasm --opt src > output.wasm
```

**Requirements**

Currently requires node v22

```bash
# Or nvm
fnm install v22
```

# Overview

Quick overview of the language. More detailed reference available [here](./reference/)

For a more detailed reference see

## Comments

```rust
// Comments are single line and are marked with a c style slash slash
```

## Primitive Types

```rust
true // Boolean
false // Boolean
1 // i32 by default
1.0 // f64 by default
"Hello!" // String, can be multiline, supports interpolation via ${}
[1, 2, 3] // Array literal
(1, 2, 3) // Tuple literal
{x: 2, y: 4} // Structural object literal
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

```rust
add(1, 2)
```

Voyd also supports uniform function call syntax (UFCS), allowing functions to be called on a type as if they were methods of that type.

```rust
1.add(2)
```

### Labeled arguments

Status: Not yet implemented

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


## If Expressions

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

## Loops

Status: Not yet implemented

While loops are the most basic looping construct

```rust
while condition
  do_work()
```

For loops can iterate through items of an iterable (such as an array)

```rust
for item in iterable
  print item
```

## Structural Objects

Structural objects are types compatible with any other type containing
at least the same fields as the structure.

```rust
fn get_x(obj: { x: i32 })
  obj.x

pub fn main()
  let vec = {
    x: 1,
    y: 2,
    z: 3
  }

  vec.get_x() // 1
```

## Nominal Objects

Nominal objects attach a name (or brand) to a structure, and are only
compatible with extensions of themselves.

```rust
obj Animal {
  age: i32
}

obj Cat extends Animal {
  age: i32,
  lives: i32
}

obj Dog extends Animal {
  age: i32,
  borks: i32
}

fn get_age(animal: Animal)
  animal.age

pub fn main()
  let dog = Dog { age: 3, borks: 0 }
  dog.get_age() // 3
  let person = { age: 32 }
  person.get_age() // Error { age: 32 } is not a type of animal
```

## Methods

```rust
obj Animal {
  age: i32
}

impl Animal
  pub fn get_age(animal: Animal)
    animal.age
```

## Intersections

Intersections combine a nominal type and a structural type to define
a new type compatible with any subtype of the nominal type that also
has the fields of the structural type.

```rust
obj Animal { age: i32 }
obj Snake extends Animal {}
obj Mammal extends Animal { legs: i32 }

type Walker = Animal & { legs: i32 }

fn get_legs(walker: Walker)
  walker.legs

pub fn main()
  let dog = Mammal { age: 2, legs: 4 }
  dog.get_legs
```

## Unions

Unions define a type that can be one of a group of types

```rust
obj Apple {}
obj Lime {}
obj Orange {}

type Produce = Apple | Lime | Orange
```

## Match Statements

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

Match statements must be exhaustive. When matching against a nominal
object, they must have an else (default) condition. When matching against
a union, they must have a case for each object in the union

## Traits

Status: Not yet implemented

Traits define a set of behavior that can be implemented on any object type
(nominal, structural, union, or intersection)

```rust
trait Walk
  fn walk() -> i32

// Implement walk for any type that contains the field legs: i32
impl Walk for { legs: i32 }
  fn walk(self)
    self.walk

// Traits are first class types
fn call_walk(walker: Walk)
  walker.walk

fn do_work(o: Object)
  // Traits also have runtime types
  if (o has_trait Walk) then:
    o.call_walk()
```

## Closures

Status: Not yet implemented

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

Status: Basic implementation complete for objects, functions, impls, and type
aliases. Inference is not yet supported.

```rust
fn add<T>(a: T, b: T) -> T
  a + b
```

With trait constraints

```rust
fn add<T: Numeric>(a: T, b: T) -> T
  a + b
```

## Effects

Status: Not yet implemented

Effects (will be) a powerful construct of the voyd type system. Effects
are useful for a large class of problems including type safe exceptions,
dependency injection, test mocking and much more.

Think of libraries like TypeScript's [Effect](https://effect.website/) library,
built directly into the language.

```rust
effect Exception
  // An effect that may be resumed by the handler
  ctl throw(msg: String) -> void

// Effects with one control can be defined concisely as
effect ctl throw(msg: String) -> void

effect State
  // Tail resumptive effect, guaranteed to resume exactly once.
  // Are defined like normal functions
  fn get() -> Int
  fn set(x: Int) -> void

// Tail resumptive effects with one function can be defined more concisely as
effect fn get() -> Int
```

## JSX

Status: In Progress

Voyd has built in support for JSX. Useful for rendering websites or creating
interactive web apps

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
