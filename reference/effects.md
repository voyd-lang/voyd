# Effects

Void language is intended to have full support for, and be largely built on top
of, algebraic effects.

Largely inspired by the paper ["Structured Asynchrony with Algebraic Effects" by
Daan
Leijen](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf),
as well as the [Effeckt Language](https://effekt-lang.org/).

## Defining Effects

```
// src/throws.void
effect State<T>
	// Ctl effects yield to the handler and may be resumed
	ctl set(val: T) -> T
	// Fn effects are tail resumptive and return a value, use this if you don't need to yield and expect to always resume exactly once
	fn get() -> T
```

## Handling An Effect

```
// Define a function that uses the state effect
fn bump_state(): State<i32> -> void
	let state = get()
	let new_state = set(state + 1)
	log(new_state)


// Define a function that handles the state effect
fn main(val: i32)
	var state = 0
	with handler:
		get: () => state
		set: (val) =>
			state = val
			resume(state)
	do:
		bump_state()
	print(state) // 5
```

Define and use generic effect handler (@f is a call by name parameter, see functions for more details)
```
fn state_handler<T>({initial: T, @action: ((): State<T> -> T)}) -> T
	var state = initial
	with handler:
		get: () => state
		set: (val) =>
			state = val
			state
	do:
		f()

fn main()
	let state = state_handler initial: 3 action:
		bump_state()
		bump_state()

	print(state) // 5
```
