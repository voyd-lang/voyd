---
order: 280
---

# Effects

Effects make side effects explicit in function types and let code handle them
with typed handlers.

## Declaring effects

```voyd
eff Async
  await(resume, value: i32) -> i32
  await_tail(tail, value: i32) -> i32
```

The first parameter on an operation declares its continuation behavior:

- `resume`: the handler may resume zero or one time
- `tail`: the handler must tail-resume exactly once before returning or
  propagating another effect

## Handling effects

Use try clauses like this to handle effects

```voyd
fn load_default(value: i32): () -> i32
  try
    Async::await(value)
  Async::await(resume, current):
    if i_want_to_resume:
      resume(current + 1)
  Async::await_tail(tail, current):
    tail(current) // Tail operations *must* return
```

Normal `try` handlers *must* be exhaustive. That is, they must handle all
operations of the effects they capture. Use `try open` to forward unhandled
operations up the callstack.

```voyd
fn load_default(value: i32): () -> i32
  try open
    Async::await(value)
  Async::await(resume, current):
    if i_want_to_resume:
      resume(current + 1)
```

### Overloaded operations

Like normal functions, effect operations can be overloaded. To disambiguate
overloaded operations in a handler, add the corresponding type annotations
to the op handler

```voyd
eff Log
  write(tail, value: String) -> void
  write(tail, value: i32) -> void

fn emit(): Log -> void
  Log::write("ready")
  Log::write(200)

fn handled() -> void
  try
    Log::write(200)
  Log::write(tail, value: String):
    // Do something with string
    tail()
  Log::write(tail, value: i32):
    // Do something with int
    tail()
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

## Reusable With Handlers

With handlers are functions that handle the effects of a callback. This
can be useful whenever you need to re-use an effect handler

```voyd
eff Console
  read(tail) -> String
  write(tail, value: String) -> void

fn with_fake_console(work: fn(): Console -> T)
  try
    work()
  Console::read(tail):
    tail("fixture")
  Console::write(tail, _value):
    tail()

fn main()
  with_fake_console do:
    let echo = Console::read()
    Console::write(echo)
```

With handlers can also be useful when you only need to partially implement an
effect handler and can fallback to with handler behavior for other effect ops

```voyd
fn custom_read_handler()
  with_fake_console do:
    try open // this will forward unhandled effects up to the `with_fake_console` handler
      let echo = Console::read()
      Console::write(echo)
    Console::read(tail):
      tail("hiii")
    // Console::write is handled by with_fake_console
```

## Using effects in function types

Effects can be annotated in a normal function signature with this syntax:

```voyd
fn name(...params): Effects -> ReturnType
```

When a functions effects are explicitly annotated, voyd will automatically
error if any additional unhandled effects are forwarded from the function.
Put multiple effects in a parenthetical list.

You may also add `open` if you wish to allow additional effects be forwarded
from the function without erroring. This is helpful when the annotations are
more for documentation, or you are documenting a closure who's effects you wish
to handle, but still want to allow the closure to have additional effects

```voyd
// Single effect annotation
fn load(value: i32): Async -> i32
  Async::await(value)

fn load_twice(value: i32): (Async, Console) -> i32
  let first = Async::await(value)
  Console::write(first + 1)

fn load_twice(value: i32): (Async, open) -> i32
  let first = Async::await(value)
  Logger::info(first + 1)
```

If an effect row is omitted, Voyd infers it locally.

Function types can also spell effect rows directly:

```voyd
fn load_with(cb: fn(): Async -> i32) -> i32
  cb()
```

Note: Exported APIs *must* annotate their effects.


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

## Effect hosts in tests

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

## Exported APIs

Functions exported from a package must either be pure *or* have all of their
effects explicitly annotated.

If an effectful function is handled by the host, you should use `@effect` and
`@operation` wrappers to supply a stable id. This makes supplying handlers
for those effects much easier

```voyd
@effect(id: "com.example.log")
eff Log
  @operation(id: "write.String")
  write(tail, value: String) -> void
  @operation(id: "write.i32")
  write(tail, value: i32) -> void

fn main(): Log -> i32
  Log::write("Hello world!")
  Log::write(42)
  0
```

From the host:
```ts
const result = await sdk.compile({ source: "the above example" })
const output = await result.run({
  entryName: "main",
  handlers: {
    "com.example.log::write.i32": ({ tail }, value) => {
      console.log(value * 5)
      tail()
    },
    "com.example.log::write.String": ({ tail }, value) => {
      console.log(value)
      tail()
    },
  },
});
```

In general effects should use dotted stable id's similar to the above example.
