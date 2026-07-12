---
order: 5
---

# Releases

## Voyd v0.3.0 - Gaia BH1

Voyd `0.3.0` is the full-stack web release. The work since `0.2.0` connects
Voyd's type system, effects, tasks, WebAssembly compiler, and host runtime into
one application model: typed VX apps in the browser, HTTP services and server
rendering on Node, and external packages that still look like ordinary Voyd
APIs.

This release spans 68 merged changes. The visible theme is web development, but
the compiler underneath it also changed substantially: typed host boundaries,
stronger whole-program optimization, faster incremental app edits, better
diagnostics, and clearer compiler and test architecture.

### Highlights

- VX now has a typed `Program<Model, Msg>` architecture with commands,
  subscriptions, async task commands, browser events, DOM patching, server
  rendering, and hydration.
- `std::http` provides HTTP client and server primitives. The new
  `@voyd-lang/web` package adds routing, typed extraction, middleware, response
  conversion, static files, cookies, limits, timeouts, and VX-backed HTML.
- `voyd bootstrap` can scaffold either a VX single-page app or a full-stack SSR
  app.
- `@external` functions and effects let Voyd packages use host-language
  implementations through generated contracts and adapters. The new
  `@voyd-lang/markdown` package is the first complete example.
- Typed SDK exports validate DTOs automatically and use direct Wasm calls for
  compatible scalar signatures.
- Release builds gain whole-program analysis, effect and call-shape
  specialization, array and dispatch fast paths, and Binaryen closed-world GC
  optimization.

### VX becomes an application runtime

The VX API is now organized around a small, typed state machine:

```voyd
use std::number::cast::to_string
use std::vx::all

obj Model {
  count: i32
}

enum Msg
  Increment
  Decrement

pub fn app() -> Program<Model, Msg>
  program({ init, step, view })

fn init() -> Model
  Model { count: 0 }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::Increment:
      next(Model { count: model.count + 1 })
    Msg::Decrement:
      next(Model { count: model.count - 1 })

fn view(model: Model) -> Html<Msg>
  <main>
    <button on_click={Msg::Decrement {}}>-</button>
    <span>{to_string(model.count)}</span>
    <button on_click={Msg::Increment {}}>+</button>
  </main>
```

`Model` is durable application state. `Msg` is the closed set of events that
can change it. `step` returns the next model plus optional command work, while
`subscriptions` describes ongoing outside input. The runtime owns DOM patches,
listener and subscription lifetimes, async command execution, and hydration.

Commands now cover tasks, HTTP, clipboard access, document titles, navigation,
history, scrolling, selection, opening URLs, and browser storage. Subscriptions
cover keyboard input, connectivity, window size and focus, visibility,
animation frames, media queries, location changes, storage events,
`BroadcastChannel`, and custom host input.

The same typed virtual tree renders in the browser or on the server. VX's
boundary schema validates models, messages, commands, subscriptions, and event
payloads while keeping the serialized transport behind the runtime contract.

Read the full [VX reference](./vx.md).

### HTTP and a Voyd web framework

`std::http` replaces the earlier `std::fetch` API with client and server
primitives. On top of that, `pkg::web` lets handlers receive typed values and
return ordinary Voyd values:

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

type UserParams = {
  id: String
}

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/health") do:
      "ok"

    get("/users/:id") do(params: UserParams):
      params.id
```

The framework includes static and parameterized routes, nested route groups,
middleware, params/query/header/cookie/body extraction, response conversion,
JSON DTO helpers, static files, body and request limits, cooperative handler
timeouts, server backpressure controls, VX server rendering, and hydration
helpers. The Node SDK also exposes `serveWebApp` for host lifecycle management.

The `web-ssr` bootstrap connects these pieces into a runnable project. The
mini-wikipedia example now exercises the complete stack: Voyd owns the server,
API routes, JSON persistence, search, validation, SSR view, hydration state,
and client-side VX state machine.

Read the full [Web reference](./web.md).

### External packages without framework coupling

Voyd packages can now declare bodyless functions and asynchronous effects whose
implementations come from JavaScript or another host language:

```voyd
@external(id: "example:markdown/renderer@1")
pub fn render(source: String) -> StaticHtml
```

Package authors can run `voyd generate adapter` to emit a portable contract,
typed TypeScript bindings, an adapter helper, and a WIT interface. Node runs
discover installed adapters automatically. Browser applications generate a
static registry so bundlers can see every required import.

The API is independent of VX. Renderers, parsers, database clients, and crypto
libraries all use the same boundary. Synchronous functions use the direct host
adapter path, while host work that may suspend is represented as an external
Voyd effect.

`@voyd-lang/markdown` is the first reference package. It uses Marked in its host
adapter, but exposes ordinary Voyd functions and a VX component. Markdown is
converted to a bounded, inert node DTO: raw HTML is text, active URL schemes
are rejected, and the VX renderer never receives an `innerHTML` escape hatch.

Read [External packages](./external-packages.md) for the package format and
runtime contracts.

### Typed boundaries for ordinary exports

Typed boundary exports are no longer VX-specific. Public functions that accept
or return boundary-compatible values can be called through the SDK with normal
JavaScript values. The compiler emits a schema, the host validates and converts
arguments and results, and recursive optional DTOs are represented through
schema references while rejecting actual cyclic runtime values.

Scalar signatures take a faster path. When `bool`, `i32`, `i64`, `f32`, `f64`,
or `void` maps directly to the physical Wasm ABI, the release build avoids the
serialized wrapper and most supporting runtime reachability. For the minimal
`pub fn main() -> i32` case, the typed artifact shrank from 17,111 bytes to 783
bytes and warm `runPure` dispatch improved from 0.901 µs to 0.146 µs per call.

### A stronger release optimizer

The SDK and compiler now expose explicit `none`, `balanced`, and `release`
optimization levels. The release pipeline combines compiler-owned semantic
facts with Binaryen's aggressive and closed-world GC passes.

Compiler work in this release includes:

- local tail-effect specialization and static-effect specialization across
  recursive call graphs;
- receiver and trait-dispatch specialization;
- safe `Array.len` and `Array.at` fast paths, including proven-safe loops;
- whole-program escape analysis and scalar aggregate replacement;
- redundant runtime type-check elimination and semantic copy forwarding;
- compact call shapes for default arguments;
- indexed worklists, dependency-aware scheduling, bounded fixed points, and
  explicit specialization budgets;
- cached dependency semantic snapshots for faster application edits.

Across the six-scenario optimizer scorecard, closed-world release optimization
reduced raw Wasm from 162,288 to 151,474 bytes (`-6.66%`) and gzip size from
56,469 to 54,824 bytes (`-2.91%`). The vtrace workload improved by 6.71% in the
same comparison. Static-effect specialization also removes the residual effect
ABI from eligible recursive functions, restoring tail calls and allowing the
representative evaluator to complete at depth 250,000 instead of overflowing.

Optimization is now measured in CI through differential correctness checks,
corpus hashes, size and runtime scorecards, compile-phase telemetry, and
regression budgets.

### Language and standard-library polish

Several smaller changes add up to a smoother language:

- `enum` is now in the standard prelude.
- `String` and `StringSlice` implement `Eq`.
- `std::fs::remove` removes files, symlinks, and empty directories.
- Object literals can satisfy optional structural fields.
- Overload scoring and generic inference handle labeled structural arguments,
  static generic methods, and return-only type parameters more reliably.
- Effectful default expressions now suspend and resume through the full
  parameter-initialization sequence.
- Imported effect metadata, generic escaped closures, free operators in impls,
  mutable aggregates, `EventOptions`, and UTF-8 export isolation received
  correctness fixes.
- Missing commas and invalid single-colon module access now produce focused
  parser diagnostics instead of cascaded module or typing errors.

### Conformance and compiler architecture

The former mixed smoke suite has been split into three explicit contracts:
compiler-neutral conformance, public cross-package integration, and opt-in
performance tests. The initial conformance manifest contains 118 portable cases
and can load another compiler through `VOYD_CONFORMANCE_ADAPTER`.

CI now separates unit, conformance, integration, codegen, packaged CLI, and
conditional optimizer lanes, records timings, enforces checked-in budgets, and
cancels superseded runs.

Inside the compiler, parser-owned surface views now normalize context-free
syntax once for the module graph, macro expansion, documentation, binding, and
lowering. The optimizer has likewise moved from a monolithic pipeline to
explicit indexes, passes, scheduling, mutation contracts, and telemetry. These
boundaries do not change the language by themselves, but they make future
compiler work considerably safer.

### Breaking changes

- `std::fetch` has been removed. Use `std::http::client` for outbound HTTP.
- VX applications now expose `app() -> Program<Model, Msg>`, construct the app
  with `program`, and return transitions with `next`. Component state IDs are
  generated from stable call sites; remove explicit `state(id:)` arguments.
- Runtime diagnostics and Binaryen validation are disabled by default for
  unoptimized builds. Set `runtimeDiagnostics: true` when investigating runtime
  traps or validating generated Wasm.
- Reference-bound (`~`) parameters cannot have defaults. Use an overload or
  callee-owned local storage.

### Upgrade notes

Install the new CLI with:

```bash
npm i -g @voyd-lang/cli@0.3.0
```

Update all directly consumed Voyd packages together. For existing applications,
the two source migrations to check first are `std::fetch` imports and the VX
`Program<Model, Msg>` app shape.

New projects can start from either template:

```bash
voyd bootstrap my-app --template vx-spa
voyd bootstrap my-app --template web-ssr
```

## Voyd v0.2.0 - M87*

This first minor release since launch brings a few new features and a whole ton
of backend compiler polish. This includes tasks, timers, open effects, trailing
callback clauses, compiler optimization work, and a set of bug fixes around
typing and lowering.

### Highlights

- Same-run task concurrency is now part of the standard library and JS host
  runtime. Programs can spawn, await, cancel, and yield tasks while leveraging
  Voyd's effect model.
- Timer APIs now build on the task model, including `time::sleep`,
  `time::set_timeout`, and `time::set_interval`.
- Trailing callback clauses make callback-heavy calls read like ordinary Voyd
  blocks instead of nested inline lambdas.
- `try forward` is now `try open`, and open effect row syntax is clearer.
- Compiler optimization improved with scalar replacement for non-escaping object
  locals and a cleaner codegen plan.
- Bug fixes landed for mutable value receiver lowering, object init signature
  hints, structural field metadata, and singleton union inference.

### Tasks

The biggest new runtime feature in `0.2.0` is tasks. Voyd programs can now spawn
work, await its result, cancel it, yield cooperatively, and suspend with timers
through APIs in `std::task` and `std::time`.

Tasks are same-run and same-event-loop. Spawning a task does not create a new
thread. It schedules another piece of Voyd work inside the current run, and the
runtime moves between tasks when they complete, await, yield, or suspend on
time. That gives Voyd a concurrency model that fits the JS host and browser
event loop while still giving programs a real language-level handle for
scheduled work.

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

Timers use the same model. `time::sleep` suspends the current task, while
`time::set_timeout` schedules new task work and returns a task you can await or
cancel.

```voyd
use std::async::types::{ Cancelled }
use std::task
use std::time::{ Duration }
use std::time

pub fn main(): (task::TaskRuntime, time::Time) -> i32
  let timeout = time::set_timeout(Duration::from_millis(5)) do:
    7

  match(timeout.await())
    Ok { value }:
      value
    Err { error }:
      0
    Cancelled:
      0
```

With tasks, a Voyd program can start background work, wait for a result, model
cancellation, build timer-based APIs, and keep those operations visible in
ordinary function signatures. Attached child tasks also participate in
structured concurrency, so owner cancellation and unobserved child failures have
defined behavior.

Tasks mark one of the first real use cases where the languages effect system
starts to shine. I'm very excited to see how they play out in practice.

### Open effects

The language now supports defining explicit open effect rows in function and
callback types. With this change, a function can now require a callback to
explicitly have some effects, without preventing it from having others.

```voyd
// `cb` must be allowed to perform Async. Any other callback effects remain open to the caller.
fn call_open<T>(cb: fn() : (Async, open) -> T) : (open) -> T
  try open
    cb()
  Async::await(tail, value):
    tail(value + 1)
```

To make `open` effects more ergonomic, `try forward` was renamed to `try open`.
This is a breaking change, so existing code will need to be updated before
upgrading to `0.2.0`.

### Trailing callback clauses

The release also adds full trailing callback clauses. Callback-heavy APIs can
now read as indented Voyd code, which is especially useful for task and timer
work.

```voyd
// Before
let timeout = time::set_timeout(
  Duration::from_millis(5),
  () =>
    let frame = get_next_frame()
    render_world(frame)
)

// After
let timeout = time::set_timeout(Duration::from_millis(5)) do:
  let frame = get_next_frame()
  render_world(frame)

// Parens can be omitted if the closure is the only arg
let worker = task::spawn do:
  let _ = time::sleep(Duration::from_millis(10))
  sync_once()
```

The clause head can name callback parameters too:

```voyd
stream::fold(init: 0) do(acc, item):
  // `acc` and `item` are parameters of the callback lambda.
  acc + item
```

And labeled callback arguments can use the same clause style:

```voyd
stream::fold(init: 0)
  // This passes the lambda to the labeled `step` argument of fold.
  step(acc, item):
    acc + item
```

### Compiler polish

The compiler also gets a round of optimization and correctness work. Scalar
replacement lets codegen avoid materializing some non-escaping object locals,
and codegen is preloaded during graph loading so compilation starts from a
warmer path.

Several fixes should make everyday code less surprising: mutable value receivers
lower correctly again, object init signature hints are clearer, structural field
metadata is preserved more consistently, and singleton unions collapse before
they leak awkward inferred shapes into later compiler stages.

### Breaking changes

- `try forward` has been renamed to `try open`.
- Code using the previous open effect row spelling should be updated to the new
  open row syntax.

### Upgrade notes

Install the new CLI with:

```bash
npm i -g @voyd-lang/cli@0.2.0
```

If you are updating existing code, the main syntax migration is changing `try
forward` to `try open` and updating any code that used the previous open effect
row spelling.

All published Voyd packages now move together at `0.2.0`, including the
compiler, SDK, JS host, standard library, reference package, language server,
CLI, and VS Code extension.

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
more explicit and type-driven than JavaScript or TypeScript, but less ceremonial
than a traditional systems language. Something that reads like a high-level
language, compiles to WebAssembly, and still gives me confidence in what the
program is allowed to do.

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
just needs something with a `name` and an `email`, I do not want to invent a new
named wrapper every time.

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
- A built-in doc generator so source code can become real API docs with `voyd
  doc`
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
