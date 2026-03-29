---
order: 5
---

# Releases

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

### Closing

Voyd is still early. This `0.1.0` release is not me saying the language is
finished. It is me saying it has reached the point where I am excited to share
it properly.

I have spent a long time building this on nights, weekends, and in between
other work because I care deeply about the space it occupies. I wanted a
language that was ambitious about types and effects, practical about tooling,
and grounded in real application programming.

That is what Voyd is trying to be.
