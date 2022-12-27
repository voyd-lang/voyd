# Functions

Syntax:

```dream
fn $name([$label:?$param-name:$ParamType]*) [$effects? -> $return-type]?
	$body:Expr*
```

## Examples

Basic function:

```dream
fn add(a:i32 b:i32) -> i32
	a + b

// To call
add 1 2

// Or
add(1 2)

// Or
(add 1 2)

// Or with UFCS
1.add(2)
```

With labels:

```
fn multiply(a:i32 by:b:i32) -> i32
	a * b

// To call
multiply 1 by: 2

// Or
multiply(1 by: 2)

// Or with UFCS. NOTE: Will not work if first argument is labeled
1.multiply(by: 2)
```

With return type inference:

```dream
fn add(a:i32 b:i32)
	a + b
```

With effects:

```dream
fn get-json(address:String) Async -> Dictionary
	let json-text = await fetch(address)
	parse-json json-text
```

## Struct Literal Parameters

Struct literal parameters allow property shorthand and do not care about order, unlike labeled parameters

```dream
fn move-to { x:i32, y:i32, z: i32 } -> void
	robot.move x y z

// With other parameters
fn move-to(scale:scale:i32, { x:i32, y:i32, z:i32 }) -> void
	move-to { x: x * scale, y: y * scale, z: z * scale }

fn main() -> void
	let z = 7
	move-to { z, x: 5, y }

	move-to scale: 5 { x: 1, y: 2, z: 3 }
```

**Note:** For now, struct parameters must be passed as an inline struct
literal only. That feature requires anon struct literals. So this won't work quite yet.

```dream
let pos = { x: 3, y: 4, z: 2 }
move-to scale: 3 pos // ERROR!
```
