# Memory Model

## Reference and Value Types

Value types are copied when referenced, reference types are not. All objects and functions are reference types. Everything else is a value types.

## Mutable References

```
obj Points
	x: number
	y: number
	z: number


let point: &Point = &Point { x: 1, y: 2, z: 3 }

// An object must be prefixed with & to have any mutation applied to it
&point.x = 3

// Mutating method example
impl Point
	fn shift-y(&self, val: number)
		&self.y += val

&point.shift-y(5)

// When not prefixed with `&`, references are treated as immutable
// Only non-mutating operations may be applied to the reference
point.print() // { x: 3, y: 7, z: 3 }
```

## Ownership

1. Unlimited immutable references can be held for an object provided _all_ references are immutable.
2. Only one mutable reference can be held for an object at a time.
