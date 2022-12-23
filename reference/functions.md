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
