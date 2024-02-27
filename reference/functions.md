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
fn get-json(address: String) Async -> Dictionary
	let json-text = await fetch(address)
	parse-json(json-text)

// Multiple effects may be specified
fn get-json(address: String) Async Throws -> Dictionary
	let json-text = await fetch(address)
	parse-json(json-text)
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
