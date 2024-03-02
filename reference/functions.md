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
