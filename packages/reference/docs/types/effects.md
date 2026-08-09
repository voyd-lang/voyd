---
order: 280
---

# Effects

Effects make side effects explicit in function types and let code handle them
with typed handlers.

## Declaring effects

```voyd
@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32
  await_tail(tail, value: i32) -> i32
```

The first parameter on an operation declares its continuation behavior:

- `resume`: the handler may resume zero or one time
- `tail`: the handler must tail-resume exactly once before returning or
  propagating another effect

Effect operations can overload by parameter types. A qualified call
searches only that effect, then uses ordinary call typing to select an overload.
Handlers must annotate every non-continuation parameter when a handler head is
overloaded.

```voyd
@effect(id: "com.example.log")
eff Log
  @operation(id: "write-text")
  write(tail, value: String) -> void
  @operation(id: "write-code")
  write(tail, value: i32) -> void

fn emit(): Log -> void
  Log::write("ready")
  Log::write(200)

fn handled() -> void
  try
    Log::write(200)
  Log::write(tail, value: i32):
    tail()
```

`@operation(id: "...")` gives an operation a stable host-facing identity. IDs
are unique inside their effect and may not contain `::`. `@type` is reserved
for the language and is not an operation attribute.

## Using effects in function types

```voyd
fn load(value: i32): Async -> i32
  Async::await(value)

fn load_twice(value: i32): Async -> i32
  let first = Async::await(value)
  Async::await_tail(first + 1)
```

If an effect row is omitted, Voyd infers it locally. Exported APIs should spell
effects out explicitly.

Function types can also spell effect rows directly:

```voyd
fn load_with(cb: fn() : Async -> i32) -> i32
  cb()
```

## Importing operations

An effect alone keeps its operations qualified. Select operations explicitly
when unqualified calls make the surrounding code clearer.

```voyd
use src::articles::ArticleStorage
use ArticleStorage::{ save_article }
use ArticleStorage::save_article as persist

fn save(content: String): ArticleStorage -> Result
  save_article(content)
```

`EffectName::all` selects every operation owned by that effect, while a grouped
selection introduces only the named operations. Fully qualified and nested
module-group spellings are equivalent:

```voyd
use src::articles::ArticleStorage::all
use src::articles::{ ArticleStorage::{ save_article } }
```

Selecting operations does not implicitly import `ArticleStorage`, and importing
the effect alone does not make `save_article(...)` an unqualified call target.
Qualified calls such as `ArticleStorage::save_article(...)` remain available.

Effect namespaces and module namespaces are separate, even when they expose the
same member spelling. The qualifier is resolved first and determines the only
table searched:

```voyd
use std::fs
use std::fs::Fs

// Typed module wrapper.
fs::rename(source, to: destination)

// Raw operation in the Fs effect.
Fs::rename(payload)
```

`fs::rename` can resolve only an ordinary module export, while `Fs::rename` can
resolve only an operation declared by `Fs`. An effect alias preserves that
identity, so `use std::fs::Fs as Files` makes `Files::rename(...)` the same
operation as `Fs::rename(...)`. A missing operation never falls back to a
same-named function, and an ordinary module function cannot be used as a handler
clause.

If an explicitly selected operation collides with an ordinary function, use a
qualified call or give the operation a local alias. The two declarations never
form one overload set.

Effect operations are call and handler designators rather than first-class
values. `let operation = Fs::rename` is invalid. Qualified operation designators
are supported in calls, handler clauses, imports, re-exports, and language
tooling.

Effect names should describe the required capability with a noun such as
`ArticleStorage` or `ArticleAccess`; a universal `Effect` suffix usually adds no
meaning.

## Handling effects

```voyd
fn load_default(value: i32): () -> i32
  try
    Async::await(value)
  Async::await(resume, current):
    resume(current + 1)
```

`try open` handles selected operations and leaves the rest open to the caller.
The handler qualifier must name an effect (or an alias of one), and the clause
matches the exact operation identity used by the call. Its first binder must use
the operation's declared `tail` or `resume` mode.

### Reusable `with_*` handlers

Use an ordinary higher-order function when the same complete effect policy is
needed in several places. This is useful for repeated host setup, test doubles,
resource scoping, and a shared policy for operations that a test does not
exercise. Name the policy, not only the effect, when several behaviors exist:
`with_fixture_console`, `with_read_only_files`, or `with_transaction` is clearer
than a collection of anonymous fallbacks.

The reusable outer handler should normally be closed and exhaustive. Each
operation resumes with its declared result type, so effects whose operations
return different types remain statically checked:

```voyd
@effect(id: "example.console")
eff Console
  read(tail) -> String
  write(tail, value: String) -> void

fn with_fixture_console<T>(work: fn() : Console -> T) -> T
  try
    work()
  Console::read(tail):
    tail("fixture")
  Console::write(tail, _value):
    tail()
```

When one call needs a focused override, place an inner `try open` inside the
outer policy. Operations named by the inner handler use the override; unmatched
operations propagate to the exhaustive outer handler:

```voyd
fn with_empty_read<T>(work: fn() : Console -> T) -> T
  with_fixture_console(() =>
    try open
      work()
    Console::read(tail):
      tail("")
  )
```

Keep an inline handler when the policy is used once or depends closely on local
control flow. Adding an operation to an effect intentionally breaks closed outer
handlers until they choose typed behavior for it. `try open` is the only
forwarding mechanism: there is no value-producing fallback clause, implicit
result-type selection, or erased continuation.

### Effect hosts in tests

Treat an effect continuation as an ownership boundary. A value passed to
`tail` or `resume` must be owned independently of any active mutable borrow.
The most direct mock-host pattern separates fixed response fixtures from
mutable observations:

```voyd
use std::array::Array
use std::shared_cell::SharedCell

@effect(id: "example.storage")
eff Storage
  read(tail, key: String) -> String
  write(tail, key: String, value: String) -> void

obj MockStorage {
  read_fixture: String,
  writes: SharedCell<Array<String>>
}

fn with_mock_storage<T>(host: MockStorage, work: fn() : Storage -> T) -> T
  try
    work()
  Storage::read(tail, _key):
    // The immutable fixture is already an owned stable value.
    tail(host.read_fixture)
  Storage::write(tail, value):
    host.writes.with_mut((~writes) => writes.push(value))
    // The SharedCell borrow has ended before the continuation runs.
    tail()
```

For a mutable source, take an owned snapshot inside `with` or `with_mut`, end
the callback, and only then invoke the continuation. Keep immutable response
fixtures as ordinary values. Use `SharedCell<T>` for counters, captured writes,
and other observations that must change across handler calls. Do not invoke a
continuation from inside a `SharedCell` callback or weaken the borrow contract
to make a test double compile.

## Row polymorphism

Higher-order functions can stay generic over their callback effects.

```voyd
fn repeat_twice<T>(cb: fn() -> T): Array<T>
  [cb(), cb()]
```

The compiler infers an effect-row parameter for the callback when needed. You can
also spell the row out explicitly when you need to distinguish between omitted,
closed, and open callback effect rows:

```voyd
fn omitted<T>(cb: fn() -> T) -> T
  cb()

fn closed<T>(cb: fn() : Async -> T) -> T
  cb()

fn call_open<T>(cb: fn() : (Async, open) -> T) : (open) -> T
  try open
    cb()
  Async::await(tail, value):
    tail(value + 1)

fn with_nested_callback(
  cb: fn(inner: fn() : (open) -> i32) -> i32
) : (open) -> i32
  cb(() => 1)
```

- `fn() -> T` omits the callback row and leaves it effect-polymorphic.
- `fn() : Async -> T` is a closed callback annotation with only `Async`.
- `fn() : (Async, open) -> T` requires `Async` and keeps the remaining callback
  effects open.
- `fn() : (open) -> T` is the explicit spelling for a fully open callback row.

`try open` composes with open callback rows. When a higher-order function
handles `Async` from `fn() : (Async, open) -> T`, the remaining callback effects
continue to bubble outward through the open tail row.

Nested callback parameters use the same spelling. In
`fn(inner: fn() : (open) -> i32) -> i32`, the `inner` callback can perform any
effects and the outer callback remains polymorphic over effects caused by
calling it.

## Exported APIs

Smoke tests enforce these rules:

- exported pure APIs may omit an effect annotation
- exported effectful APIs must declare their effect row explicitly

## Stable ids

Public effects should use stable dotted ids such as
`@effect(id: "voyd.std.fs")`.
