# Effects

Effects are resumable exceptions. They capture side-effects in the type system
so that functions must either expose them in their signature or handle them.

## At a Glance

- Effects bundle named operations that may suspend and resume execution.
- Operation behavior is signaled by the first parameter:
  - `resume` means resumable; the handler may resume zero or one time.
  - `tail` means tail-resumptive; the handler must resume exactly once.
- Function types carry an effect row: `fn load(): (Async, Log) -> Bytes`.
- Effects are inferred locally, but exported APIs should **spell them out** or
  handle everything and remain pure (`()`).
- Effect rows can be polymorphic: `fn map<effects E>(f: fn(T): E -> U): E -> Array<U>`.
- Handlers remove handled effects from the row; unhandled effects propagate.
- Effects don’t “poison” the call stack: higher-order code can stay pure and
  let callbacks carry or discharge their own effects.

Voyd's effect system takes heavy inspiration from:
- [Koka Language](https://koka-lang.github.io)
- [Effeckt Language](https://effekt-lang.org/)
- [Structured Asynchrony with Algebraic Effects (Daan Leijen)](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)

---

## Declaring Effects

An effect is a set of named operations:

```voyd
eff Exception
  // Resumable operation; the handler may resume zero or one time.
  fn throw(resume, msg: String) -> void

// Single-operation shorthand
eff throw(resume, msg: String) -> void

eff State
  // Tail-resumptive operations; the handler will resume exactly once.
  fn get(tail) -> Int
  fn set(tail, x: Int) -> void

// Single-operation shorthand
eff get(tail) -> Int
```

Operations that start with a `resume` parameter expose the current continuation
to the handler and may be resumed zero or one time. Operations that start with a
`tail` parameter are tail-resumptive (like `await` or `yield from`) and are
guaranteed to resume exactly once by the handler.

---

## Raising and Handling Effects

```voyd
eff Async
  await(tail) -> i32
  resolve(resume, value: i32) -> void
  reject(resume, msg: String) -> void

fn async_task(): Async -> i32
  let num = Async::await()
  if num > 0 then:
    Async::resolve(num)
  else:
    Async::reject("Number must be positive")

fn main(): () -> void
  try
    async_task(1)
  await(tail):
    tail(rand_int())
  resolve(resume, num):
    log("Resolved: " + num)
  reject(resume, msg):
    log("Rejected: " + msg)
```

Notes:
- Effect operations are invoked like static functions (`Async::resolve`), or by
  importing them: `use Async::{resolve, reject}`.
- Unhandled operations propagate to the caller and stay in the function's effect
  row. Handled operations are removed from the row.
- A handler may re-raise an effect (keeping it in the row) or fully discharge
  it.
- Handlers are written as clauses after `try`: each clause matches an operation
  by name and destructures its parameters (including `resume`/`tail`).

---

## Typing and Inference

- Function signatures use `: <effects> -> <return>`:

  ```voyd
  fn fetch(url: String): (Async, Log) -> Response
  fn parse(data: Bytes): () -> Json // explicit pure annotation
  ```

- If the effect annotation is omitted, the compiler infers effects from the
  body. Inference is fine inside a package, but exported APIs should be
  explicit to keep semver-stable surface areas.
- Handlers shrink effect rows. For example, `try ... with Async` yields a pure
  result if the handler covers all Async operations and does not re-raise.

---

## Polymorphic Effects

Higher-order utilities should pass through effects rather than invent new ones.
Voyd supports **effect row polymorphism** via `effects` parameters:

```voyd
// map does not add effects; it preserves whatever `f` does.
fn map<T, U>(
  items: Array<T>,
  f: fn(T) -> U,
): Array<U>
```

Effect parameters behave like type parameters:

- Declared alongside type parameters with the `effects` keyword when you need
  them explicitly.
- Omitted for callbacks when you want inference; the compiler effectively
  elaborates `fn map<T, U>(..., f: fn(T) -> U)` into
  `fn map<T, U, effects E>(..., f: fn(T): E -> U): E -> Array<U>`.
- You can still write the explicit form when you need to name/compose the
  effect row:

  ```voyd
  fn with_logging<effects E, T>(f: fn() -> T): (Log, E) -> T
  ```

- Are generalized when not constrained, enabling call-site inference.

### No call-stack poisoning

Effects from callbacks do not “infect” unrelated callers—only invoked effects
flow through the row, and you can keep higher-order utilities pure when they
don’t call the callback:

```voyd
// Stores handlers without invoking them: stays pure.
fn register(handler: fn() -> void): () -> void
  handlers.push(handler)

// Invokes the callback and transparently passes its effects through.
fn run(handler: fn() -> void)
  handler()

// Inference keeps this simple: no effect annotation, but `Async` flows through.
fn repeat_twice<T>(cb: fn() -> T): Array<T>
  [cb(), cb()]

fn main(): Async -> Array<i32>
  repeat_twice(() => Async::resolve(1))
```

This mirrors Effekt: a callback’s potential effects matter only when you run it.

### Handling callback effects inline

A function can also take a callback with an explicit effect and discharge it
itself, keeping its own row pure:

```voyd
eff Exception
  throw(resume, msg: String) -> void

fn with_default<T>(cb: fn(): Exception -> T, fallback: T): () -> T
  try
    cb()
  throw(resume):
    fallback
```

---

## Exports and Purity (`pkg.voyd`)

To keep package APIs explicit and auditable:

- Inside a package (anything not exported from `src/pkg.voyd`), you can rely on
  effect inference; explicit annotations are optional.
- In `src/pkg.voyd` (the public API per `visibility.md`), every exported
  function must either:
  - spell out its effects (including any `effects` parameters), or
  - be explicitly pure `()`.
  Omitting an effect annotation in `pkg.voyd` means “assume pure”; if the body
  is not pure, it is a compile-time error.
- Exported polymorphic functions must still declare their effect parameters:

  ```voyd
  pub fn transform<effects E, T>(f: fn(T): E -> T): E -> T
  ```

- A function that handles all effects internally can advertise purity by
  annotating `()` (even if effects were inferred in helpers it calls).

This keeps cross-package dependencies predictable and prevents accidental API
changes when internal implementations start using new effects.
