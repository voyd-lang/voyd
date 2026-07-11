# Agent Quick Reference For Idiomatic Voyd

This is a fast pre-flight for agents writing or reviewing Voyd source in this
repo, especially under `packages/std` and `.voyd` compiler/smoke fixtures. It
does not replace the language reference. When syntax or semantics are in
question, check `packages/reference/docs` and the existing tests before
guessing.

## Read These First

- `packages/reference/docs/syntax.md`: indentation, clauses, calls, lambdas.
- `packages/reference/docs/functions.md`: overloads, labels, defaults, effects.
- `packages/reference/docs/types/effects.md`: effect declarations, rows, handlers.
- `packages/reference/docs/types/objects.md`, `traits.md`, `value-types.md`,
  `unions.md`, and `enums.md`: the main type families.
- `packages/reference/docs/modules.md` and `visibility.md`: imports, package
  exports, `pub`, `api`, and `pri`.
- For std API work, skim nearby files in `packages/std/src` and matching
  `*.test.voyd` files before adding a new spelling.

## Syntax Shape

- Voyd is indentation-sensitive. Use two-space indentation.
- Blocks return their last expression.
- Use `=` only for single-expression declarations or bindings.
- Multi-line `if`, `match`, `while`, and `for` use clause syntax with `:`.
- Single-line `if` expressions use `then:`.
- Prefer parenthesized calls in ordinary code. Unparenthesized calls are for
  DSL-like paths where readability is clearly better.

```voyd
fn clamp_sign(value: i32) -> i32
  if
    value < 0: -1
    value > 0: 1
    else: 0

fn inc(value: i32) = value + 1
```

## Functions, Labels, And Calls

- Declare functions with `fn`; exported top-level functions use `pub fn`.
- Return types may be omitted when local inference is obvious, but public APIs
  are clearer with explicit returns.
- Put effect rows between the parameter list and return type:
  `fn read(path: Path): Fs -> Result<String, IoError>`.
- Pure functions can omit the row. Use `: () -> T` when you need to spell a
  closed pure function type or keep consistency with low-level wrappers.
- Labeled parameters are declared by wrapping a group in `{ ... }`.
- Use labels for APIs with more than two non-`self` parameters unless there is
  a strong readability reason not to.
- Labels can differ from local parameter names: `{ to end: f64, at t: f64 }`.
- Optional parameters use `?`; default parameters use `=`.
- Do not combine `?` and `=` on the same parameter.
- In generic functions, defaulted parameters need explicit types.

```voyd
pub fn lerp(start: f64, { to end: f64, at t: f64 }) -> f64
  start + ((end - start) * t)

pub fn split(
  source: StringSlice,
  { on separator: i32, max_splits?: i32, keep_empty?: bool }
) -> Array<StringSlice>
  source.split(on: separator, max_splits: max_splits, keep_empty: keep_empty)
```

## Overloads And API Design

- Use overloads for the same conceptual operation, not unrelated behavior.
- Overloads are selected by argument types and labels. They may not differ only
  by return type.
- Prefer semantic names and labels over type-encoded suffixes.
- For public APIs that accept `StringSlice`, provide a `String` overload with
  identical behavior. Make one overload a thin forwarder.
- Use labels to distinguish overlapping overload families:
  `contains(value)`, `contains(where: pred)`, `slice(from: start, to: end)`.

```voyd
pub fn write(value: StringSlice): Output -> Result<Unit, IoError>
  write(value, StdOut {})

pub fn write(value: String): Output -> Result<Unit, IoError>
  write(value.as_slice())
```

## Effects

- Declare public effects with stable dotted ids:
  `@effect(id: "voyd.std.fs")`.
- Effect names are UpperCamelCase; operation names are snake_case.
- Canonical effect operation declarations omit `fn` inside `eff` blocks.
- The first operation parameter is continuation behavior:
  `resume` may resume zero or one time; `tail` must tail-resume exactly once
  before returning or propagating another effect.
- Exported effectful APIs must spell their effect row explicitly. Smoke tests
  enforce this. Exported pure APIs may omit the row.
- Use `try` to handle effects completely. Use `try open` to handle selected
  operations and forward the remaining open row.
- Higher-order callbacks can be effect-polymorphic. Use `fn() -> T` for an
  omitted callback row, `fn() : Async -> T` for a closed row, and
  `fn() : (Async, open) -> T` when a required effect should leave the rest open.

```voyd
@effect(id: "voyd.std.output")
pub eff Output
  write_op(tail, payload: MsgPack) -> MsgPack

pub fn print(value: StringSlice): Output -> void
  match(write_line(value))
    Ok<Unit>:
      void
    Err<IoError>:
      void

fn call<T>(cb: fn() : (Async, open) -> T) : (open) -> T
  try open
    cb()
  Async::await(tail, value):
    tail(value + 1)
```

## Data Types

- Use structural aliases when shape compatibility is the point:
  `type Point = { x: i32, y: i32 }`.
- Use `obj` when the type needs nominal identity, hidden fields, recursive
  structure, shared state, or trait-object use.
- Use `val` for small fixed-layout value-semantic data such as vectors, colors,
  intervals, and other math-heavy records.
- Unions contain nominal object/value variants. `Optional<T>` is
  `Some<T> | None`; `Result<T, E>` is `Ok<T> | Err<E>`.
- Enums are the stable surface for named variant families that fit enum syntax.
- Construct nominal values with object-literal or constructor-call syntax.

```voyd
pub val Vec3 {
  x: f64,
  y: f64,
  z: f64
}

pub obj Path {
  pri raw: String
}

impl Path
  api fn init(value: StringSlice) -> Path
    Path { raw: value.to_string() }
```

## Traits, Impl Blocks, And Methods

- Traits describe behavior for nominal types.
- Methods live in `impl` blocks.
- Use `self` for value/immutable receiver access and `~self` for mutation.
- Methods can be called with dot syntax. Ordinary functions can also be used in
  UFCS style when the first argument is the receiver.
- Operator overloads are named with quoted operators, for example
  `fn '+'(self, other: Vec3) -> Vec3`.

```voyd
trait Sequence<T>
  fn iter(self) -> Iterator<T>

impl Vec3
  fn '+'(self, other: Vec3) -> Vec3
    Vec3 { x: self.x + other.x, y: self.y + other.y, z: self.z + other.z }
```

## Mutability

- `let` bindings are immutable; `var` bindings are reassignable.
- Field mutation requires mutable access with `~`.
- Use `let ~value = ...` for a local mutable object binding.
- Function and method parameters must also request mutable access explicitly:
  `fn reset(~point: Point) -> void`, `fn push(~self, value: T) -> void`.
- Module-level `let ~value = ...` is not supported.

## Option, Result, And Early Returns

- Prefer explicit `match` when branching on `Option` or `Result` carries
  behavior or diagnostics.
- Use `??` for simple optional fallback and `?.` for simple optional chaining.
- Construct options/results with `Some<T> { value }`, `None {}`,
  `Ok<T> { value }`, and `Err<E> { error }`.
- `return` is valid and commonly used for guard exits, but expression-oriented
  code is preferred when it remains clear.

```voyd
fn count_or_zero(value: Option<i32>) -> i32
  value ?? 0

fn unwrap_count(result: Result<i32, IoError>) -> i32
  match(result)
    Ok<i32> { value }:
      value
    Err<IoError>:
      0
```

## Modules And Visibility

- Import paths start with `self::`, `super::`, `src::`, `std::`, or `pkg::`.
  Bare paths are not valid in `use` declarations.
- `pub` in ordinary modules means package-visible.
- `pkg.voyd` controls the public package API through `pub use` or `pub ...`
  re-exports.
- Members visible across package boundaries require `api` when their owning
  type is exported.
- Use `pri` for fields or methods that should stay private to the owning object.

```voyd
use std::result::types::all
use std::string::type::{ String, StringSlice }

// pkg.voyd
pub self::fs
pub std::result::types::{ Result, Ok, Err }
```

## Std And Compiler Contributor Habits

- Before inventing syntax, find a nearby example in `packages/std/src`,
  `tests/conformance/cases`, `tests/integration/fixtures`, or
  `packages/compiler/src/semantics/__tests__/__fixtures__`.
- Prefer std wrappers over raw `__*` intrinsics. Raw intrinsic declarations are
  std/compiler surface only.
- Keep low-level intrinsic wrappers small and typed, with the `@intrinsic`
  declaration next to the wrapper.
- Keep public std APIs documented with `///`; use `//!` for module docs.
- Put behavior tests near the owning layer. For portable language behavior,
  prefer `tests/conformance`; for cross-package behavior, prefer
  `tests/integration`; for std module behavior, prefer existing
  `packages/std/src/*.test.voyd` files when ownership is local.
- Do not paper over compiler bugs by adding odd annotations to fixtures unless
  the test is specifically about such an annotation. Fix the root compiler path
  when the request is a compiler bug.

## Pre-Submit Checklist For Voyd Source

- Did you use two-space indentation and valid clause syntax?
- Are public effectful APIs annotated with explicit effect rows?
- Did you use labeled parameters for multi-argument APIs where labels clarify
  roles?
- Are `String` and `StringSlice` overloads paired for public string APIs?
- Are mutable receivers and parameters marked with `~` only where mutation is
  needed?
- Did you choose `type`, `obj`, `val`, `trait`, `enum`, or union based on the
  semantics rather than habit?
- Are `pub`, `api`, and `pri` used at the correct boundary?
- Did you match nearby std/compiler test style before adding new test shape?
