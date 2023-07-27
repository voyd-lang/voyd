# Effects Spec

Void language is intended to have full support for, and be largely built on top of, algebraic
effects. Based on the paper ["Structured Asynchrony with Algebraic Effects" by Daan Leijen](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf). Void's effects semantics are closely aligned with those of
[Koka](https://koka-lang.github.io)

## Defining Effects

```
// src/throws.void
effect throws::<T>
	ctl throw(val: T) -> void
```

// Single operation effects can be defined as (effect type would be throw)

```
effect ctl throw::<t>(val: T) -> void
```

Note: Effect types are lower-kebab-case, data types are UpperCamelCase

## Handling An Effect

```
fn validate(val: i32) -> (async ())
	if val > 100 or val < 0
		throw "Value out of range"

// Returns true when the value is between 0 and 100, false otherwise
fn is-valid(val: i32)
	with ctl throw(val) false
	validate(val)
	true
```

// Define a generic handler

```
handler try::<T> impl throw::<T>
	ctl throw(val)

fn try::<T, R>(action: () -> (throws::<T> R), catch: (T) -> R) -> R
	handles throw
	handle(action)
```

**Combining effects:**

```
effect type ThrowsAndLogs = Throws & Console

// Or this (but would have to list everything out I should think)
effect ThrowsAndLogs extends (Throws, Console)
```

## Implementation Ideas

- `ctl` handlers (i.e. `with ctl`) could potentially implemented in wasm today using threads/atomics
- Tail resumptive handlers (i.e. `with fn`) would likely be as simple as calling the handler and returning the results
