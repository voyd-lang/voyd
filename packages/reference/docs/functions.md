---
order: 40
---

# Functions

## Declarations

```voyd
fn add(a: i32, b: i32) -> i32
  a + b

fn inc(x: i32) = x + 1
```

Return types may be omitted when inference is clear.

```voyd
fn fib(n: i32)
  if n < 2:
    n
  else:
    fib(n - 1) + fib(n - 2)
```

Return types may be module-qualified or unions.

```voyd
fn build() -> math::Vec3
  math::Vec3 { x: 1, y: 2, z: 3 }
```

## Overloads

Voyd supports function overloading.

- Overloads are selected by argument types and labels.
- Overloads may differ by label style.
- Overloads may not differ only by return type.

## Labeled parameters

Wrap a parameter group in `{ ... }` to define labeled arguments.

```voyd
fn clamp(value: i32, { min: i32, max: i32 }) -> i32
  if value < min:
    min
  else:
    if value > max then: max else: value

clamp(7, min: 1, max: 5)
```

You can rename the internal parameter while keeping the external label.

```voyd
fn reduce<T>(value: T, { reducer cb: (T, T) -> T, start: T }) -> T
  cb(start, value)
```

Passing a structural object is also valid.

```voyd
clamp(7, { min: 1, max: 5 })
```

## Optional parameters

Use `?` to make a parameter optional. The source-level type displays as
optional syntax, while the value behaves like an `Optional<T>`.

```voyd
fn greet(name: String, middle?: String) -> String
  match(middle)
    Some<String> { value }:
      "${name} ${value}"
    None:
      name

greet("Ada")
greet("Ada", "Lovelace")
```

Optional labeled parameters work the same way.

```voyd
fn render({ title: String, subtitle?: String }) -> String
  title
```

## Default parameters

Use `=` to supply a default argument value.

```voyd
fn repeat(times = 3) -> i32
  times

fn log({ level: String = "info", message: String }) -> String
  "[${level}] ${message}"
```

Defaults are supported on positional and labeled parameters. Trait methods,
effect operation signatures, and lambda parameters do not currently support
default values.

Current restrictions:

- In generic functions, a defaulted parameter must declare an explicit type.
- A default expression cannot reference a parameter declared at the same
  position or later in the parameter list.
- `?` and `=` cannot be combined on the same parameter.

## Lambdas

Lambdas use `=>` and close over surrounding bindings.

```voyd
let inc = (x: i32) => x + 1

fn make_adder(base: i32)
  (delta: i32) -> i32 => base + delta
```

Nested lambdas capture outer values as expected.

Use `fn(Arg1Type, Arg2Type, Etc) -> ReturnType` to type a lambda.

```voyd
fn calls_lambda(cb: fn(f64, i32) -> String)
  cb(7.8, 4)
```

## Methods and UFCS

Methods are defined in `impl` blocks.

```voyd
obj Counter {
  value: i32
}

impl Counter
  fn inc(self) -> i32
    self.value + 1

let counter = Counter { value: 1 }
counter.inc()
```

UFCS-style dot calls also work for ordinary functions.

```voyd
1.add(2)
```

Voyd also supports unparenthesized call syntax in DSL-like cases where it reads
more clearly than nested punctuation.

```voyd
log value
clamp number min: 0 max: 10
```

Prefer ordinary parenthesized calls for general-purpose code and use the
unparenthesized form sparingly.

## Effects

Functions can declare effects between the parameter list and return type.

```voyd
fn fetch(value: i32): Async -> i32
  Async::await(value)
```

See [Effects](./types/effects.md) for the full effect model.

## Generics

Functions can be generic and constrained.

```voyd
fn id<T>(value: T) -> T
  value

fn render<T: Drawable>(value: T) -> String
  value.draw()
```

See [Generics](./generics.md) for details.
