---
order: 5
---

# Releases

## Voyd v0.3.0 - Gaia BH1

This release is centered around Voyd's full-stack web development experience.
Gaia BH1 fills in both sides of Voyd's web stack. VX brings an Elm-inspired
architecture to interactive UIs, while new HTTP client and server APIs in `std`
and the `pkg::web` framework support server-side applications. Stronger release
optimizations, a new bootstrap command, and more round out the release.

All these features should come together to make developing real production
full stack web applications both practical and pleasant.

### New `voyd bootstrap` Command

The CLI ships with two project templates:

```bash
voyd bootstrap my-app --template vx-spa
voyd bootstrap my-app --template web-ssr
```

`vx-spa` creates a browser application with Vite, Tailwind, Voyd compilation,
and a typed VX starter. `web-ssr` creates a server-rendered application with an
HTTP server, shared VX views, browser hydration, static assets, and a development
workflow.

### The VX UI Framework

Gaia BH1 introduces VX, an Elm-inspired framework for building interactive
UIs with idiomatic Voyd. VX gives an application a typed architecture for state,
events, effects, and rendering, with views that can render in the browser or on
the server.

A VX app is a typed state machine. `Model` holds the current application state,
`Msg` describes every event, `step` calculates the next state, and `view`
renders it:

```voyd
use std::string::type::String
use std::time::{ Duration }
use std::time
use std::vx::all

obj Model {
  status: String
}

enum Msg
  StartTimer
  TimerFinished

pub fn app() -> Program<Model, Msg>
  program({ init, step, view })

fn init() -> Model
  Model { status: "Ready" }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::StartTimer:
      next(
        model: Model { status: "Steeping..." },
        cmd: start_timer()
      )
    Msg::TimerFinished:
      next(Model { status: "Tea is ready!" })

fn view(model: Model) -> Html<Msg>
  <main>
    <p>{model.status}</p>
    <button on_click={Msg::StartTimer {}}>Start tea timer</button>
  </main>

fn start_timer() -> Cmd<Msg>
  Cmd::task
    work():
      time::sleep(Duration::from_secs(180i64))
    handler(_result):
      Msg::TimerFinished {}
```

`Model` is durable application state. `Msg` is the closed set of events that
can change it. A button click produces a `Msg`, and `step` returns the next
`Model` plus any command to run. VX patches the DOM from the next `view` result,
then sends command results back through the same message loop. The signatures
connect each part, so a view can only emit messages that the app knows how to
handle.

`StartTimer` shows how asynchronous work fits into the loop. Its `step` branch
immediately changes the status to `Steeping...` and returns a command created by
`start_timer`. `Cmd::task` runs the wait as a Voyd task and maps its result to
`TimerFinished`; VX dispatches that message when the delay ends, and `step`
changes the status to `Tea is ready!`.

This keeps `step` focused on transitions: accept a message, choose the next
model, and describe any work to start. HTTP requests, database writes, and other
asynchronous operations follow the same command-to-message pattern.

VX includes commands for tasks, clipboard access, document titles, navigation,
history, scrolling, selection, opening URLs, and browser storage. Subscriptions
cover keyboard input, connectivity, window size and focus, visibility,
animation frames, media queries, location changes, storage events,
`BroadcastChannel`, and custom host input.

Read the full [VX reference](./vx.md).

### HTTP in the Standard Library

`std::http` provides the shared protocol types and low-level capabilities for
both sides of HTTP. Applications can send outbound requests through
`std::http::client`, or listen, accept requests, and respond through
`std::http::server`.

These APIs are useful directly when an application needs control over the HTTP
lifecycle. They also provide the foundation for higher-level server frameworks.

### The New `pkg::web` Server Framework

`pkg::web` is a server-side HTTP application framework built on `std::http`. It
adds routes, typed request extraction, middleware, response conversion, cookies,
static files, limits, and timeouts while leaving the underlying HTTP types and
capabilities in the standard library.

VX and `pkg::web` meet at server rendering: `pkg::web` can return a rendered VX
view, embed its hydration state, and serve its browser assets. Once the page
loads, VX owns the interactive UI. Each framework can also be used without the
other.

A route handler can ask for the values it needs in its parameter list and
return an ordinary Voyd value:

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

Path parameters, query values, headers, cookies, and JSON bodies can all be
decoded into typed records. Return values such as `String`, `JsonValue`,
`Response`, `Option<T>`, and `Result<T, E>` become HTTP responses through the
same handler model.

The mini-wikipedia API saves a decoded `Article` directly:

```voyd
serve(port: 3000) routes():
  put("/api/articles", body: json_body()) do(article: Article):
    save_article(article)

  delete("/api/articles/:slug") do(ctx: Context):
    delete_article(ctx.param("slug") ?? "")
```

The page route renders the VX tree on the server and includes the model needed
for hydration:

```voyd
fn article_page(model: Model) -> Response
  Response::ok()
    .with(header: "content-type", value: "text/html; charset=utf-8")
    .text(document<Msg, Model>(
      view: page_view(model),
      hydrate: hydrate<Model>(
        target: "#wiki-app",
        entry: "/assets/client.js",
        model: model
      )
    ))
```

The browser starts from that model, attaches the VX runtime to the rendered
tree, and continues through the same `Msg` and `step` loop. The shared view
function owns the server page and the interactive browser updates.

Read the full [Web reference](./web.md).

### External Package Adapters

Voyd packages can now expose a typed Voyd API implemented by JavaScript or
another host language. The application imports the package through the normal
`pkg::` namespace.

The first package built this way is `@voyd-lang/markdown`:

```bash
npm install @voyd-lang/markdown
```

```voyd
use pkg::markdown::Markdown
use std::vx::all

fn Article({ source: String }) -> Html<AppMsg>
  <article class="wiki-article">
    <Markdown source={source} />
  </article>
```

The component calls a JavaScript adapter powered by Marked. The adapter returns
a restricted tree of text, elements, and attributes. Voyd turns that tree into
ordinary VX nodes, so Markdown content participates in normal validation,
rendering, and DOM updates. Raw HTML becomes text, and active link and image
schemes are rejected.

Package authors declare host-backed functions with `@external` and generate the
adapter contract from the CLI:

```voyd
@external(id: "example:search/index@1")
pub fn search(query: String) -> Array<SearchResult>
```

```bash
voyd generate adapter ./src --out ./generated
```

The generated output includes typed TypeScript bindings, runtime contract
metadata, and a WIT interface. Node discovers installed adapters during a run.
Browser builds use a generated static registry for their adapter imports.

Read [External packages](./external-packages.md) for the package format and
runtime contracts.

### Typed SDK Boundary Exports

Public Voyd functions can now cross the SDK boundary with booleans, numbers,
strings, arrays, records, optional values, results, and enum variants. JavaScript
passes plain values, and the generated boundary schema validates every argument
and result.

Here is a Voyd function that accepts and returns a record:

```voyd
obj Point {
  x: i32,
  y: i32
}

pub fn translate(point: Point, dx: i32, dy: i32) -> Point
  Point { x: point.x + dx, y: point.y + dy }
```

The SDK call uses a normal JavaScript object:

```ts
const point = await result.run({
  entryName: "translate",
  args: [{ x: 1, y: 2 }, 10, 20],
});

// { x: 11, y: 22 }
```

Enum values arrive as tagged objects, arrays arrive as JavaScript arrays, and
recursive optional DTOs support data such as trees. Scalar signatures map
directly to Wasm with JavaScript-side type validation.

Read the [SDK reference](./sdk.md) for supported boundary shapes and embedding
APIs.

### Faster Release Builds

Use the release optimization profile when building an application for
deployment:

```bash
voyd --emit-wasm --opt ./src > app.wasm
```

I compared Gaia BH1 with the `v0.2.0` tag using identical source files, Node
22.23.1 on Apple silicon, three fresh-process compile samples, and five runtime
samples per workload after eleven warmups. The complete setup is checked in as
the `docs/release/v0.3.0-benchmark.md` release benchmark.

| Workload                                  | v0.2.0 runtime | Gaia BH1 runtime |                 Runtime change |          Raw Wasm |              gzip |
| ----------------------------------------- | -------------: | ---------------: | -----------------------------: | ----------------: | ----------------: |
| One million mutable particle steps        |      11.264 ms |         4.334 ms |               **2.60x faster** | **21.6% smaller** | **11.7% smaller** |
| Five million calls with default arguments |      37.459 ms |        25.549 ms |               **31.8% faster** |  **2.2% smaller** |       1.9% larger |
| Standard-library transcendental math      |  under 0.02 ms |    under 0.02 ms | below useful timing resolution |  **4.0% smaller** |  **2.1% smaller** |

Within Gaia BH1, the release profile also makes the two scaled workloads faster
and much smaller than the development profile:

| Workload                                  | Unoptimized |   Release |   Runtime change |   Raw Wasm change |
| ----------------------------------------- | ----------: | --------: | ---------------: | ----------------: |
| One million mutable particle steps        |   15.515 ms |  4.334 ms | **3.58x faster** | **97.2% smaller** |
| Five million calls with default arguments |   47.278 ms | 25.549 ms | **1.85x faster** | **97.8% smaller** |

Gaia BH1 also renders the vtrace ray tracer in a median of 143.5 ms, with five
runs between 143.0 and 144.8 ms producing the same checksum. Its release build
is 35.6 KB, or 13.0 KB compressed. This workload exercises effects, trait
dispatch, mutable vectors, recursive ray bounces, arrays, and a large object
graph.

Release optimization now recognizes common array loops, known method targets,
locally handled effects, recursive tail calls, short default-argument call
shapes, and non-escaping values. These improvements account for the runtime and
size reductions in the larger workloads.

The stronger release optimizer performs more compile-time analysis. The scalar
and default-argument fixtures took 52% longer to compile, the math fixture took
48% longer, and the tiny trait fixture took 97% longer. Vtrace compiled in 3.17
seconds. Development builds default to the unoptimized profile.

Typed SDK boundaries also add a fixed runtime surface to tiny modules that
expose generic public functions. The trait-only fixture stayed below 0.01 ms at
runtime and grew from 1.1 KB to 20.0 KB. Scalar-only exports use the direct Wasm
boundary path described in [Typed SDK Boundary Exports](#typed-sdk-boundary-exports).

### Language and Standard Library Improvements

Gaia BH1 also smooths out several parts of day-to-day Voyd code:

- `enum` is available from the standard prelude.
- `String` and `StringSlice` implement `Eq`, so they work naturally with APIs
  that accept equality-constrained values.
- `std::fs::remove` removes files, symlinks, and empty directories.
- Object literals can fill structural types that contain optional fields.
- Generic inference understands more labeled arguments, static generic methods,
  and return-driven type arguments.
- Default expressions can perform effects and resume through the remaining
  parameter initialization.
- Missing commas and invalid module access produce focused parser diagnostics
  at the source location.
- Fixes cover imported effects, escaped generic closures, operators in impls,
  mutable values, browser event options, and UTF-8 exports.

### Upgrading from 0.2.0

Install the new CLI and update directly consumed Voyd packages together:

```bash
npm i -g @voyd-lang/cli@0.3.0
```

Outbound HTTP now lives in `std::http::client`. Update `std::fetch` imports and
calls to the client API:

```voyd
use std::http::client::self as http_client

let response = http_client::get("https://example.com/api")
```

VX applications expose `app() -> Program<Model, Msg>`, construct the app with
`program({ init, step, view, subscriptions })`, and return transitions through
`next(...)`. Component state IDs now come from stable call sites, so explicit
`state(id:)` arguments should be removed.

Runtime diagnostics and Binaryen validation are opt-in for unoptimized builds.
Set `runtimeDiagnostics: true` when investigating a runtime trap or validating
generated Wasm. Reference-bound (`~`) parameters cannot declare defaults; an
overload or callee-owned local value expresses that API shape.

If you want to see the release working as one application, explore
[The Small Knowledge](https://github.com/voyd-lang/voyd/tree/main/examples/mini-wikipedia),
the file-backed wiki built with Voyd, VX, `pkg::web`, SSR, hydration, HTTP, and
filesystem effects.

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
