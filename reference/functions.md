# Functions

## Function Basics

```void
fn add(a: i32, b: i32) -> i32
  a + b

// Usage
add(1, 2)

// Or with UFCS
1.add(2)
```

With return type inference:

```void
fn add(a: i32, b: i32) = a + b
```

With effects:

```void
fn get_json(address: String): Async -> Dictionary
  let json_text = await fetch(address)
  parse_json(json_text)

// Multiple effects may be specified in parenthesis
fn get_json(address: String): (Async, Throws) -> Dictionary
  let json_text = await fetch(address)
  parse_json(json_text)
```

## Labeled arguments

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

## Uniform Function Call Syntax (Dot Notation)

The dot (or period) operator applies the expression on the left as an argument
of the expression on the right.

```
5.add(1)

// Becomes
add(5, 1)

// Parenthesis on the right expression are not required when the function only takes one argument
5.squared

// Becomes
squared(5)
```

See the chapter on [Syntax](./syntax.md) for more information.

## Generics

```rust
fn add<T>(a: T, b: T) -> T
  a + b
```

With trait constraints

```rust
fn add<T impls Numeric>(a: T, b: T) -> T
  a + b
```

See the chapter on [Generics](./generics.md) for more information.

## Call By Name Parameters

Call by name parameters automatically wrap the passed expression in a closure.
Call by name parameters are defined by prefixing the parameter type with `@`.
Their type must always be a function type with no parameters.

```rust
fn eval_twice(@f: () -> void) -> void
  f()
  f()

fn main()
  var x = 0
  eval_twice(x = x + 1)
  print(x) // 2
```

Use by name parameters very SPARINGLY. And only when the function name makes
it obvious that the parameter is a function.

## Parenthetical Elision

When a function call is the top level call of its line, the parenthesis surrounding
the arguments (as well as the commas) can be elided.

```rust
fn add_three_numbers(a: i32, b: i32, c: i32) -> i32
  a + b + c

add_three_numbers 1 2 3
```

Indented lines are treated as blocks and supplied as arguments to the function
on the previous line

```rust
add_three_numbers 1 2
  let x = 1
  let y = 2
  x + y
```

This can be used to achieve trailing closures, much like swift:

```rust
fn call_with_5(f: (i32) -> void) -> void
  f(5)

call_with_5 (x) =>
  print(x)
```

By name parameters make this feature even more powerful:

```rust
fn eval_twice(@f: () -> void) -> void
  f()
  f()

fn main()
  var x = 0
  eval_twice
    x = x + 1
  print(x) // 2
```

Parenthetical elision also works with labeled arguments:

```rust
fn add(a: i32, {to: i32}) = a + to

add 1 to: 2
```

Labeled arguments may also be supplied on a new line on the same indentation
level as the function call provided no empty on that indentation level separate
the two:

```rust
add 1
to: 2
```

Labeled arguments can also be call by name parameters, which allows for the
implementation of a custom DSL for native like control flow:

```rust
fn my_if(@condition: () -> bool, {@then: () -> void, @else: () -> void}) -> void
  if condition then:
    then()
  else:
    else()

my_if true then:
  print("It's true!")
else:
  print("It's false!")
```

See the chapter on [Syntax](./syntax.md) for more information and detailed rules.

## Function Overloading

Void functions can be overloaded. Provided that function overload can be
unambiguously distinguished via their parameters and return type.

```void
fn sum(a: i32, b: i32)
  print("Def 1")
  a + b

fn sum(vec: {a:i32, b: i32})
  print("Def 2")
  vec.a + vec.b

sum a: 1, b: 2 // Def 1
sum { a: 1, b: 2 } // Def 2

// ERROR: sum(numbers: ...Int) overlaps ambiguously with sum(a: Int, b: Int)
fn sum(numbers: ...Int)
  print("Def 3")
```

This can be especially useful for overloading operators to support a custom
type:

```
fn '+'(a: Vec3, b: Vec3) -> Vec3
  Vec3(a.x + b.x, a.y + b.y, a.z + b.z)

Vec3(1, 2, 3) + Vec3(4, 5, 6) // Vec3(5, 7, 9)
```

### Rules

-   A function signature is:
-   Its identifier
-   Its parameters, their name, types, order, and label (if applicable)
-   Each full function signature must be unique in a given scope
-   TBD...
