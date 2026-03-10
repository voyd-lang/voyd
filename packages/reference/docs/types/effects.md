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

## Handling effects

```voyd
fn load_default(value: i32): () -> i32
  try
    Async::await(value)
  Async::await(resume, current):
    resume(current + 1)
```

`try forward` handles selected operations and forwards the rest to the caller.

## Row polymorphism

Higher-order functions can stay generic over their callback effects.

```voyd
fn repeat_twice<T>(cb: fn() -> T): Array<T>
  [cb(), cb()]
```

The compiler infers an effect-row parameter for the callback when needed. You can also
spell it out explicitly with `effects` parameters.

## Exported APIs

Smoke tests enforce these rules:

- exported pure APIs may omit an effect annotation
- exported effectful APIs must declare their effect row explicitly

## Stable ids

Public effects should use stable dotted ids such as
`@effect(id: "voyd.std.fs")`.
