---
order: 5
---

# Releases

## Voyd v0.2.0 - M87*

The first Voyd release was mostly about getting the language out into the
world. This one is about making the center of the language sturdier and more
useful in everyday programs.

`0.2.0` brings tasks, timers, open effects, trailing callback clauses, compiler
optimization work, and a set of bug fixes around typing and lowering. The theme
is practical composition: effectful code should be easier to write, easier to
read, and easier for the compiler to optimize.

### Highlights

- Same-run task concurrency is now part of the standard library and JS host
  runtime. Programs can spawn, await, cancel, and yield tasks while leveraging
  Voyd's effect model.
- Timer APIs now build on the task model, including `time::sleep`,
  `time::set_timeout`, and `time::set_interval`.
- Trailing callback clauses make callback-heavy calls read like ordinary Voyd
  blocks instead of nested inline lambdas.
- `try forward` is now `try open`, and open effect row syntax is clearer.
- Compiler optimization improved with scalar replacement for non-escaping
  object locals and a cleaner codegen plan.
- Bug fixes landed for mutable value receiver lowering, object init signature
  hints, structural field metadata, and singleton union inference.

### Tasks are now part of the language story

Voyd has had effects for a while, and effects are still the part of the
language I care about most. They let a function say what kind of outside-world
work it can do. But once you have effects, the next question shows up pretty
quickly: how do effectful programs wait, resume, schedule, and compose without
turning the runtime boundary into a pile of special cases?

This release adds the first real answer to that question. There is now a
same-run task model wired through the standard library, compiler, SDK, and JS
host. The new task and timer APIs are still early, but they give Voyd programs
a real vocabulary for async work that is visible in the language and runtime
model.

```voyd
use std::async::types::{ Cancelled }
use std::error::panic
use std::task

pub fn main(): task::TaskRuntime -> i32
  let child = task::spawn do:
    41

  match(child.await())
    Ok { value }:
      value
    Err { error }:
      panic(error.message.as_slice())
    Cancelled:
      0
```

That matters because Voyd's effect system needs to hold up when programs need
time, IO, or scheduling. Tasks need to fit inside the model. In `0.2.0`, they
start to.

### Open effects got easier to read

There is also a syntax change: `try forward` is now `try open`.

That is a breaking change, but it is the right one. "Forward" described a bit
of implementation machinery. "Open" better describes the shape of the effect
row that the code is exposing. This is one of those small language-design
renames that I would rather do now, while Voyd is still early, than carry
forever because changing it later would be annoying.

```voyd
fn call_open<T>(cb: fn() : (Async, open) -> T) : (open) -> T
  try open
    cb()
  Async::await(tail, value):
    tail(value + 1)
```

### Trailing callback clauses

The release also adds full trailing callback clauses. Callback-heavy APIs can
now read as indented Voyd code, which is especially nice for task and timer
work.

```voyd
let timeout = time::set_timeout(Duration::from_millis(5)) do:
  7

let worker = task::spawn do:
  let _ = time::sleep(Duration::from_millis(10))
  sync_once()
```

### Compiler polish users should feel

The compiler also gets a round of optimization and correctness work. Scalar
replacement lets codegen avoid materializing some non-escaping object locals,
and codegen is preloaded during graph loading so compilation work starts from a
warmer path.

Several fixes should make everyday code less surprising: mutable value
receivers lower correctly again, object init signature hints are clearer,
structural field metadata is preserved more consistently, and singleton unions
collapse before they leak awkward inferred shapes into later compiler stages.

### Breaking changes

- `try forward` has been renamed to `try open`.
- Code using the previous open effect row spelling should be updated to the new
  open row syntax.

### Upgrade notes

Install the new CLI with:

```bash
npm i -g @voyd-lang/cli@0.2.0
```

If you are updating existing code, the main syntax migration is changing
`try forward` to `try open` and updating any code that used the previous open
effect row spelling.

All published Voyd packages now move together at `0.2.0`, including the
compiler, SDK, JS host, standard library, reference package, language server,
CLI, and VS Code extension.

### Closing

I think of `0.1.0` as the "hello, this exists" release.

`0.2.0` feels like the first release where Voyd starts growing outward from its
core ideas. The core is still explicit effects, strong types, WebAssembly as the
target, and tooling that is part of the language instead of an afterthought.
The new runtime and compiler work gives those ideas more room.

That is the work I am most excited about right now: making the language easier
to extend while keeping the thread of what it is trying to be.

## Voyd v0.1.0 - Sagittarius A*

Introducing Voyd.

I started working on Voyd a little over seven years ago, on and off, as a
passion project. It has been my excuse to think deeply about the parts of
programming languages I love most: type systems, ergonomics, tooling, runtime
boundaries, and the feeling of writing code that is both expressive and
predictable.

In a lot of ways, Voyd is my love letter to programming languages.

It is heavily inspired by Rust, Swift, Koka, TypeScript, and a bunch of other
languages that shaped how I think about software. The place Voyd lands is
somewhere between Rust and TypeScript in abstraction level. I wanted something
more explicit and type-driven than JavaScript or TypeScript, but less
ceremonial than a traditional systems language. Something that reads like a
high-level language, compiles to WebAssembly, and still gives me confidence in
what the program is allowed to do.

That is the purpose Voyd serves for me: it is a language for building real
applications with a strong type system, explicit effects, a practical runtime
model, and tooling that feels like part of the language instead of an
afterthought.

### Why I built it

I have always wanted a language that combined a few things I usually had to get
from different places:

- a type system strong enough to model real application invariants
- explicit handling of side effects
- data modeling that supports both nominal and structural thinking
- WebAssembly as a real compilation target, not just a side experiment
- built-in tooling for docs, tests, and editor workflows

Most languages I love gave me part of that picture. Voyd is my attempt at
pulling those ideas into one coherent system.

### What Voyd is

Voyd is a programming language that compiles to WebAssembly. It is designed for
full stack web apps, embedded runtimes, plugin systems, and other environments
where a small, typed, portable runtime boundary is valuable.

The language tries to stay close to the generated program rather than burying
everything under layers of magic. At the same time, it is not trying to be a
minimalist assembly-flavored language. I want it to be pleasant to write every
day.

### The type system is the main event

If Voyd has a defining feature, it is the type system.

Two of the ideas I am most excited about are effects and the hybrid nominal /
structural type system.

#### Effects

Effects make side effects part of the type of a function. That means you can
look at a function signature and understand whether it is pure, whether it can
perform IO, whether it can suspend, and what capabilities it depends on.

```voyd
@effect(id: "app.http")
eff Http
  get(resume, url: String) -> String

fn load_user_name(id: String): Http -> String
  Http::get("/users/" + id)
```

That sounds academic, but in practice it is really useful. It lets APIs be
honest. It keeps capability boundaries explicit. It also makes embedding and
hosting much cleaner, because the runtime contract is visible in the program
type instead of being hidden behind conventions.

#### Hybrid nominal / structural types

I did not want to choose between nominal typing and structural typing because I
think both are genuinely useful.

Nominal types are great when identity matters. If something is a `UserId` or a
`Money` or a `Session`, I want the type system to preserve that meaning.

Structural types are great when shape matters more than identity. If a function
just needs something with a `name` and an `email`, I do not want to invent a
new named wrapper every time.

Voyd lets those two styles coexist.

```voyd
obj UserId {
  value: String
}

// Nominal, only accepts UserID
fn load_user(id: UserId): Db -> { name: String, email: String }
  ...

// Structural, will accept any object containing a field, name: String
fn print_name(named_thing: { name: String })
  ...
```

That is exciting because it gives you a better modeling vocabulary.

- Use nominal types when you want the compiler to protect meaning.
- Use structural types when you want flexible composition.
- Use traits when you want shared behavior and constraints.

I think that combination ends up feeling much closer to how people actually
design programs.

### Other things I care a lot about

Voyd also includes a few features that I think should be normal:

- Traits for shared behavior, default methods, and generic constraints
- A built-in doc generator so source code can become real API docs with
  `voyd doc`
- A CLI, SDK, language server, docs site, and VSCode extension that are all
  designed together
- WebAssembly-first compilation instead of treating Wasm like a secondary target

One of my goals with Voyd has always been that the tooling should reinforce the
language design. If the language wants explicitness, the tooling should help
surface it. If the type system carries important information, the editor and
docs should make that visible.

### Installation

Install the CLI:

```bash
npm i -g @voyd-lang/cli
```

Then run a program:

```bash
voyd --run ./src/main.voyd
```

Compile to WebAssembly:

```bash
voyd --emit-wasm ./src > module.wasm
```

Generate API documentation:

```bash
voyd doc --out docs.html
```

Try it out!:

```voyd
// fib.voyd
fn fib(n: i32) -> i32
  if n < 2:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main()
  fib(10).print()
```

```
voyd --run fib.voyd
```

### Closing

Voyd is still early. This `0.1.0` release is not me saying the language is
finished. It is me saying it has reached the point where I am excited to share
it properly.

I have spent a long time building this on nights and weekends because I care
deeply about the space it occupies. I wanted a language that was ambitious about
types and effects, practical about tooling, and grounded in real application
programming.

That is what Voyd is trying to be.
