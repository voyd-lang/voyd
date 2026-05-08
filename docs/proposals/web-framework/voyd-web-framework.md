# Voyd Web Framework

Status: Proposed
Owner: Language + Std + Runtime
Scope: new framework package (recommended: `packages/web`), `apps/smoke`, host integration points

## Summary

Voyd should have a web framework that feels as ergonomic as Express, but it
should lean into Voyd's strengths instead of copying JavaScript's runtime
habits.

Core direction:

- handlers return values instead of mutating a response writer
- side effects stay explicit in handler effect rows
- labeled parameters describe extraction and policy
- trailing closures form the primary route DSL
- request concurrency uses `std::task`
- middleware stays composable and predictable
- JSON, bytes, logging, and timeouts build on the existing stdlib
- the framework remains mostly pure above the host boundary

Recommended package shape:

- framework package: `packages/web`
- public import path: `pkg::web` or `pkg::voyd_web`
- stdlib stays focused on canonical HTTP/runtime primitives

## Why This Should Feel Different From Express

Express is optimized for JavaScript's dynamic object model and callback
conventions. Voyd gives us better tools:

- explicit effects instead of ambient async I/O
- nominal and structural types for request/response modeling
- overloads and labeled parameters for readable APIs
- trailing-closure DSLs that still lower to ordinary function calls
- immutable value-returning response builders
- `Result` / `Option` instead of `null`-driven control flow
- tasks and structured concurrency for per-request work
- traits for response conversion

The framework should feel familiar in the small, but much safer and clearer in
the large.

## Use Existing Stdlib Aggressively

The framework should build on today's std surface instead of inventing parallel
abstractions.

- `std::result` and `std::optional` should be the main error/absence model.
- `std::json::JsonValue` should power JSON responses in the MVP.
- `std::bytes::Bytes` should back raw request/response bodies.
- `std::dict::Dict` and `std::array::Array` should back headers, params, and
  routing tables.
- `std::task` should model request-level concurrency, background work, and
  cancellation.
- `std::time` should power deadlines, timeouts, and scheduling helpers.
- `std::log` should be the default request logging/tracing surface.
- `std::vx` should be the default HTML templating/render-tree surface.
- `std::path` and `std::fs` should support static-file helpers, but those
  should stay optional framework layers.

## What We Should Not Reuse Directly

We should not build the framework directly on the current `std::fetch`
request/response types.

Reasons:

- they are client-shaped, not server-shaped
- they are text-body oriented
- they do not model inbound request metadata cleanly
- they would couple server design to a single client API

Instead, `std::fetch` should eventually become a client facade over shared
HTTP primitives.

## Proposed Framework Surface

### Primary Route DSL

```voyd
use pkg::web::all

serve(port: 3000) routes():
  use(request_logger)

  get("/health") do:
    "ok"

  group("/users") routes():
    get("/:id", params: UserParams) do(params, ctx):
      load_user(params.id)

    post("/", body: json<CreateUser>()) do(input, ctx):
      create_user(input)
```

Recommended top-level primitives:

- `serve({ port, host?, shutdown_timeout? }) routes(): ...`
- `get(path, ...) do...`
- `post(path, ...) do...`
- `use(...) do...`
- `group(prefix) routes(): ...`

This should be the primary documented surface.

### Lower-Level Builder Surface

The framework can still expose builder-style APIs for metaprogramming,
composition, and escape hatches:

- `web::app() -> App`
- `web::router() -> Router`
- `App.use(middleware)`
- `App.get(path, ...)`
- `App.post(path, ...)`
- `App.group(prefix, build: fn(~Router) -> void)`
- `App.mount(prefix, router)`
- `App.handle(request) -> Response`
- `web::serve(app, { port, host?, shutdown_timeout? })`

But those should be secondary to the route DSL above.

### Effect-Driven Route Registration

The clean no-`app.` DSL should be implemented by leaning into effects.

Recommended direction:

```voyd
eff AppBuild
  add_route(tail, route: RouteDefinition) -> void
  add_middleware(tail, middleware: MiddlewareDefinition) -> void
  with_group(tail, prefix: String, build: fn(): AppBuild -> void) -> void
```

Then the top-level DSL helpers become thin wrappers around that effect:

```voyd
pub fn get(path: String, handler: Handler): AppBuild -> void
  AppBuild::add_route(RouteDefinition::get(path, handler))

pub fn post(path: String, body: BodyDecoder, handler: Handler): AppBuild -> void
  AppBuild::add_route(RouteDefinition::post(path, body, handler))

pub fn use(middleware: Middleware): AppBuild -> void
  AppBuild::add_middleware(MiddlewareDefinition::init(middleware))

pub fn group(path: String, build: fn(): AppBuild -> void): AppBuild -> void
  AppBuild::with_group(path, build)
```

And `serve(...)` captures the declarations by handling `AppBuild`:

```voyd
pub fn serve({
  port: i32,
  routes build: fn(): AppBuild -> void
}): (HttpServer, TaskRuntime) -> i32
  let ~registry = AppRegistry::init()

  try
    build()
  AppBuild::add_route(tail, route):
    registry.add(route)
  AppBuild::add_middleware(tail, middleware):
    registry.add_middleware(middleware)
  AppBuild::with_group(tail, prefix, build_group):
    registry.with_prefix(prefix, build_group)

  run_registry(registry, port: port)
```

This keeps the DSL declarative while still making the build phase explicit in
Voyd terms.

### Why Keep The Builder Surface At All

The no-`app.` effect DSL is cleaner and more distinctive.

The builder surface is still worth keeping because:

- it makes scoping more explicit for readers who prefer that style
- it is easier to use from metaprogramming or generated code
- it can serve as the lower-level escape hatch if the effect DSL feels too
  magical

### Handler Shape

Canonical handler shape:

```voyd
fn show_user(ctx: web::Context): (Db, Log) -> web::Response
  let id = ctx.param("id").unwrap_or("missing")
  Response::ok().text("user ${id}")
```

This is better than Express's `(req, res, next)` shape because:

- input is explicit
- output is a value
- effects are visible in the type
- middleware composition stays deterministic

### Why This DSL Feels Like Voyd

This direction uses three language features that should be front-and-center:

- labeled parameters for extraction and policy
- trailing closures for route and middleware bodies
- explicit effect rows on handlers

That combination is much more distinctive than a plain chain of JS-style
method calls.

For example:

```voyd
serve(port: 3000) routes():
  post(
    "/sessions",
    body: json<LoginInput>(),
    auth: optional(),
    timeout: 500
  ) do(input, ctx):
    create_session(input, ctx)
```

That is the kind of API shape the proposal should optimize for.

### Effects In Handlers

The framework should leverage Voyd effects directly instead of inventing a
parallel async/context abstraction.

Handlers and middleware should just be ordinary Voyd functions whose effect
rows describe what they need:

```voyd
fn show_user(ctx: web::Context): (Db, Log) -> web::Response
  log::info("user.show")
  match(load_user(ctx.param("id").unwrap_or("missing")))
    Ok<User> { value }:
      Response::ok().json(user_json(value))
    Err<DbError> { error }:
      Response::internal_server_error().text(error.message)

fn create_session(ctx: web::Context): (Auth, Time, Log) -> web::Response
  let now = SystemTime::now()
  match(Auth::issue_session(ctx.body_bytes()))
    Ok<Session> { value }:
      log::info("session.created")
      Response::ok().json(session_json(value, now))
    Err<AuthError> { error }:
      Response::unauthorized().text(error.message)
```

This should be a core design rule:

- the framework must not erase handler effect rows
- router/app registration APIs should remain row-polymorphic over callback
  effects
- framework-owned effects should stay minimal and narrowly scoped

In practice that means `App.get(...)`, `App.post(...)`, `App.use(...)`, and
related helpers should compose effectful callbacks without forcing app code into
an ambient runtime object.

### Labeled Extraction And Policy

Labeled parameters should be used aggressively where they improve clarity.

Recommended labels:

- `params:`
- `query:`
- `body:`
- `headers:`
- `auth:`
- `timeout:`
- `cache:` later if needed

Example:

```voyd
serve(port: 3000) routes():
  get(
    "/users/:id",
    params: UserParams,
    query: UserQuery
  ) do(params, query, ctx):
    load_user(id: params.id, verbose: query.verbose)

  post(
    "/users",
    body: json<CreateUser>(),
    auth: required()
  ) do(input, ctx):
    create_user(input)
```

This is where Voyd can feel meaningfully different from Express: extraction and
policy are visible in the route declaration instead of being hidden in dynamic
middleware chains.

### Effectful Middleware

Middleware should work the same way.

```voyd
fn request_logger(ctx: web::Context, next: web::Next): Log -> web::Response
  log::info("request.started")
  let response = next(ctx)
  log::info("request.finished")
  response

fn require_session(ctx: web::Context, next: web::Next): Auth -> web::Response
  match(Auth::current_session(ctx.request))
    Ok<Session>:
      next(ctx)
    Err<AuthError> { error }:
      Response::unauthorized().text(error.message)
```

The important idea is that middleware should remain just ordinary effectful
Voyd code, not a special framework-specific callback model.

The DSL should support middleware registration in the same style:

```voyd
serve(port: 3000) routes():
  use(auth: required()) do(ctx, next):
    match(Auth::current_session(ctx.request))
      Ok<Session>:
        next(ctx)
      Err<AuthError> { error }:
        Response::unauthorized().text(error.message)
```

### Framework-Level Effects

The framework itself should introduce as few new effects as possible.

Recommended split:

- app handlers use domain effects like `Db`, `Auth`, `Log`, `Time`
- std owns host-facing HTTP server effects
- the framework mostly stays a pure composition/routing layer

That keeps the architecture honest: effects describe real capabilities, while
the framework mostly coordinates values and callback composition.

### Response Conversion

The framework should use traits to reduce boilerplate for common returns.

```voyd
pub trait IntoResponse
  fn into_response(self) -> Response
```

Initial impls should include:

- `Response`
- `String`
- `StringSlice`
- `Bytes`
- `JsonValue`
- `vx::VxNode`
- `(Status, String)`
- `(Status, JsonValue)`

That enables handlers like:

```voyd
fn health(_ctx: web::Context) -> web::Response
  Response::ok().text("ok")

fn version(_ctx: web::Context) -> String
  "0.1.0"

fn whoami(_ctx: web::Context) -> JsonValue
  JsonObject {
    value: {
      "name": JsonString { value: "voyd" }
    }
  }
```

### HTML Rendering With `std::vx`

The framework should treat `std::vx` as the preferred server-side HTML
templating surface.

Why this makes sense:

- it already gives Voyd a structured tree/template model
- it avoids stringly-typed HTML assembly in handlers
- it fits the value-returning framework direction
- it leaves room for shared server/client rendering conventions later

Given the std proposal now treats VX as a typed render tree, the framework does
not need its own HTML wrapper type.

Recommended response helpers:

- `Response::html(value: vx::VxNode) -> Response`
- `html::render(value: vx::VxNode) -> String`
- `html::document(value: vx::VxNode) -> String` if document rendering differs
  from fragment rendering

That keeps `vx` as the authoring model and keeps HTTP response construction
typed and semantically clear without duplicating abstractions across std and
the framework.

### HTML Reader Macro

The preferred authoring surface should be the existing HTML reader macro that
lowers HTML syntax into VX.

That means users should be able to write:

```voyd
fn home_page(name: String) -> vx::VxNode
  <main>
    <h1>Voyd Web</h1>
    <p>Hello, {name}</p>
  </main>
```

rather than hand-assembling VX trees in ordinary app code.

If the VX redesign changes public node/attribute/value types, updating the HTML
reader macro should be part of the proposal. It should target the new typed VX
surface directly rather than continuing to lower into raw MsgPack helpers.

The implementor should assume the current reader macro behavior is part of the
expected UX unless explicitly changed:

- built-in tags currently lower differently from components
- capitalized tags are treated as components
- namespaced components like `UI::Card` parse today
- `{...}` interpolation can contain ordinary expressions, including lambdas
- text whitespace is collapsed in normal HTML mode
- `<pre>` and `<textarea>` preserve whitespace
- boolean attributes currently exist and lower as truthy values

This proposal expects those authoring affordances to survive the VX redesign.

Example:

```voyd
use pkg::web::Response
use std::vx

fn home_page(name: String) -> vx::VxNode
  <main>
    <h1>Voyd Web</h1>
    <p>Hello, {name}</p>
  </main>

fn home(ctx: web::Context) -> web::Response
  Response::ok().html(home_page("friend"))
```

### Reader Macro Acceptance For Web Work

For this framework to feel good, HTML syntax should remain the primary authoring
path, not a novelty wrapper over low-level constructors.

That means the combined std/framework direction should ensure:

- app authors can write HTML directly in handlers and VX components
- typed VX output is what the reader macro produces
- component composition and interpolation remain first-class
- framework examples should prefer HTML syntax over manual tree construction

### VX Components

The framework proposal should explicitly encourage small component-style VX
components instead of giant inline HTML trees.

```voyd
fn page_layout({ title: String, body: vx::VxNode }) -> vx::VxNode
  <html>
    {head(title)}
    <body>{body}</body>
  </html>
```

This is one of the places Voyd can feel especially strong: typed, composable
HTML values without falling back to fragile string concatenation.

### Context Surface

`Context` should be small and predictable.

```voyd
pub obj Context {
  api request: Request,
  api params: RouteParams,
  api query: QueryParams
}
```

Recommended helpers:

- `ctx.method() -> Method`
- `ctx.path() -> String`
- `ctx.header(name) -> Option<String>`
- `ctx.param(name) -> Option<String>`
- `ctx.query_value(name) -> Option<String>`
- `ctx.text() -> Result<String, BodyError>`
- `ctx.json() -> Result<JsonValue, BodyError>`
- `ctx.body_bytes() -> Bytes`

The MVP should avoid a dynamic `locals` bag as the primary design. If we need an
escape hatch, it should be clearly secondary.

## Middleware Model

Recommended middleware shape:

```voyd
pub type Next = fn(Context) -> Response
pub type Middleware = fn(Context, next: Next) -> Response
```

This maps well to the current language and keeps the control flow obvious.

Example:

```voyd
use std::log

fn request_logger(ctx: web::Context, next: web::Next): Log -> web::Response
  log::info("request.started")
  let response = next(ctx)
  log::info("request.finished")
  response
```

Auth middleware:

```voyd
fn require_api_key(ctx: web::Context, next: web::Next): web::Response
  match(ctx.header("x-api-key"))
    Some<String> { value }:
      if value.equals("secret"):
        next(ctx)
      else:
        Response::unauthorized().text("invalid api key")
    None:
      Response::unauthorized().text("missing api key")
```

## Routing API Examples

### Grouping

```voyd
serve(port: 3000) routes():
  group("/api") routes():
    get("/users") do(ctx):
      list_users(ctx)

    get("/users/:id") do(ctx):
      show_user(ctx)
```

### Nested Groups

```voyd
serve(port: 3000) routes():
  group("/api") routes():
    get("/health") do:
      "ok"

    group("/users") routes():
      get("/") do(ctx):
        list_users(ctx)

      get("/:id", params: UserParams) do(params, ctx):
        show_user(id: params.id)
```

### Method Fallback

```voyd
serve(port: 3000) routes():
  route("/posts/:id", method: Method::get()) do(ctx):
    show_post(ctx)

  route("/posts/:id", method: Method::delete()) do(ctx):
    delete_post(ctx)
```

### Not Found and Error Handling

```voyd
serve(port: 3000) routes():
  get("/health") do:
    "ok"

  not_found() do:
    Response::not_found().text("route not found")

  on_error() do(error: AppError):
    Response::internal_server_error().text(error.message)
```

## Response Builders

The framework should keep response construction immutable and chainable.

```voyd
Response::ok()
  .with_header("content-type", "text/plain")
  .text("hello")

Response::created()
  .json(payload)

Response::no_content()
```

Recommended builder methods:

- `Response::ok()`
- `Response::created()`
- `Response::bad_request()`
- `Response::unauthorized()`
- `Response::not_found()`
- `Response::internal_server_error()`
- `with_header(name, value)`
- `with_cookie(cookie)`
- `text(value)`
- `json(value)`
- `bytes(value)`

## Tasks, Timeouts, and Background Work

Request handlers should be able to use `std::task` and `std::time` directly.

```voyd
use std::task::self as task
use std::time::{ Duration }
use std::time::self as time

fn dashboard(ctx: web::Context): (task::TaskRuntime, time::Time) -> web::Response
  let stats_task = task::spawn(() => load_stats())
  let audit_task = task::detach(() => write_audit_log())

  let _ = time::sleep(Duration::from_millis(5))

  match(stats_task.await())
    Ok<Stats> { value }:
      Response::ok().json(render_stats(value))
    Err<TaskError> { error }:
      Response::internal_server_error().text(error.message)
    Cancelled:
      Response::internal_server_error().text("request cancelled")
```

This is one of the biggest ways the framework can feel distinctly Voyd-native:
request concurrency is explicit and typed.

## Rendering Modes

The framework should support three first-class rendering modes:

- `json` via `JsonValue`
- `html` via `vx::VxNode` built from `std::vx`
- raw bodies via `Bytes` or text

That split is cleaner than overloading everything onto strings, and it gives
server-side HTML a clear home in the framework.

## Effects At The App Boundary

The serving side should stay effect-driven too.

At the host boundary:

- `std::http::server` provides the inbound request effect
- handler/middleware effects are whatever the app actually needs
- task/time effects remain available for concurrency, deadlines, and background
  work

So a real entrypoint might look like:

```voyd
use std::http::server::HttpServer
use std::task::TaskRuntime
use std::time::Time

pub fn main(): (HttpServer, TaskRuntime, Db, Auth, Log, Time) -> i32
  serve(port: 3000) routes():
    get("/health") do:
      "ok"

    post("/users", body: json<CreateUser>()) do(input, ctx):
      create_user(input)
```

That is one of the main advantages of doing this in Voyd: the web stack keeps
the full capability story visible instead of hiding it behind ambient runtime
objects.

## Static Files

Static-file serving should be a small optional layer, not part of the core.

```voyd
let app =
  web::app()
    .use(web::serve_dir("/public"))
```

This should use `std::fs`, `std::path`, and `Bytes` under the hood. MIME type
lookup can live in the framework package initially.

## Recommended Package Split

Keep the architecture layered:

1. `std::http`
   Pure canonical HTTP values and host DTO codecs.
2. `std::http::server`
   Host-backed inbound server effect.
3. `packages/web`
   Router, middleware, app composition, response helpers, static files.

This keeps the stdlib boundary narrow and lets the framework evolve faster.

## Phasing

### Phase 1

- land the route DSL as the primary documented surface
- land pure router/app/response framework APIs underneath it
- target fully-buffered request/response bodies
- keep JSON support centered on `std::json::JsonValue`
- make `std::vx` the preferred HTML templating path
- add smoke coverage through public SDK execution

### Phase 2

- typed cookies and sessions
- route helper macros if the core API proves repetitive
- optional framework-provided request extractors
- streaming request/response support if the runtime needs it

## Testing Direction

Follow `docs/testing/test-layer-ownership.md`.

- `packages/web`: routing, middleware ordering, response conversion
- `packages/std`: HTTP DTO codecs and pure HTTP helpers
- `packages/js-host`: server adapter capability contract
- `apps/smoke`: end-to-end request handling through the public runtime

Canonical end-to-end behavior should live in `apps/smoke`.

## Recommendation

Build the framework as a value-returning, task-aware router layer on top of a
small new `std::http` foundation. Do not clone Express's mutation-heavy
`req/res/next` design. Voyd already has better primitives than that.
