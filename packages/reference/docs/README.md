---
order: 0
---

# Voyd

Voyd is a language for building WebAssembly programs with a small surface area,
strong type checking, and a runtime model that stays close to the generated
code.

```voyd
fn fib(n: i32) -> i32
  if n < 2:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main() -> i32
  fib(10)
```

## Design goals

- Read like a high-level language.
- Compile like a systems language.
- Keep package boundaries and effects explicit.
- Make macros, traits, and Wasm-facing code practical instead of ornamental.

## Installation

```bash
npm i -g @voyd-lang/cli
```

The installed command is `voyd`.

## Start here

- [Basics](./basics.md)
- [CLI](./cli.md)
- [SDK](./sdk.md)
- [Syntax](./syntax.md)
- [Functions](./functions.md)
- [Control Flow](./control-flow.md)
- [Tasks and Time](./tasks-and-time.md)
- [Modules](./modules.md)
- [Types Overview](./types/overview.md)

## Feature map

- Structural and nominal types.
- Traits with default methods.
- Algebraic effects with typed handlers.
- Same-run task concurrency and timer APIs built on the event loop.
- Macros for surface-language features such as `enum` and `for`.
- A package/module system built around `src/` and `pkg.voyd`.
