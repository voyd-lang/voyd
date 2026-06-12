# Voyd Web Framework

Status: Proposed
Owner: Std + Runtime + Framework
Scope: new framework package, recommended `packages/web`; smoke tests; SDK/server integration

## Summary

Voyd should have a web framework that is familiar in the small and distinctly
Voyd-native in the large.

The framework should feel as approachable as Express for simple routes, but it
should not copy Express's mutation-heavy `req/res/next` model. Voyd gives us
better primitives:

- handlers return values
- effects describe capabilities
- route declarations use labels for extraction and policy
- structural DTOs model params/query/body data
- nominal extractors and policies model behavior
- `Result` and `Option` replace null-driven control flow
- tasks model request-level concurrency explicitly
- traits convert ordinary return values into HTTP responses

The result should make small apps pleasant and large apps maintainable.

## Relationship To `std::http`

The framework should build on the lower-level std HTTP proposal:

- `std::http` owns `Method`, `Status`, `Headers`, `Body`, `IncomingRequest`,
  and `Response`.
- `std::http::client` owns outbound client requests and the outbound HTTP
  effect.
- `std::http::server` owns the inbound server effect.
- `packages/web` owns routing, middleware, extractors, policies, response
  conversion, static files, sessions, and framework ergonomics.

The framework may re-export `std::http::Response`, but it should not define a
second response type.

## Goals

- Make the first route examples short and readable.
- Keep handler effects visible and composable.
- Let handlers return ordinary values, including DTO-compatible values.
- Use labeled route options to make extraction and policy obvious.
- Prefer typed extractors over dynamic request bags.
- Keep middleware predictable and value-returning.
- Provide a builder API for composition and generated code, but document the
  route DSL as the primary surface.
- Hide MessagePack and host DTO mechanics from application authors.
- Make HTML rendering work through `std::vx` without forcing raw interop.

## Non-Goals

- Do not implement a general dependency-injection container.
- Do not make dynamic `locals` the primary app state mechanism.
- Do not require users to mutate a response writer.
- Do not fork the HTTP model from `std::http`.
- Do not make routing depend on runtime-specific host APIs.

## Primary DevX

This is the kind of code the framework should optimize for:

```voyd
use pkg::web::all

type UserParams = {
  id: String
}

type UserQuery = {
  verbose: bool
}

obj CreateUser {
  api name: String,
  api email: String
}

obj Session {
  api user_id: String
}

pub fn main(): (HttpServer, TaskRuntime, Db, Log) -> Result<Unit, ServeError>
  serve(port: 3000) routes():
    adopt(request_logger)

    get("/health") do:
      "ok"

    group("/users") routes():
      get("/:id") do(params: UserParams, query: UserQuery):
        load_user(id: params.id, verbose: query.verbose)

      post(
        "/",
        body: json(),
        auth: required_session()
      ) do(input: CreateUser, session: Session):
        create_user(input, by: session.user_id)
```

Important details:

- handler parameter names and types drive extraction
- route options are labeled when they configure policy, format, or ambiguity
- `ctx` is available last when requested
- return values are converted through `IntoResponse`
- `Db` is a user-defined application effect and `Log` is the std logging effect
- effect rows can be inferred; explicit annotations are useful when documenting
  capability boundaries

## Design Principles

### Handlers Return Values

Handlers should return a value that can become an HTTP response. They should not
receive a mutable response writer.

```voyd
fn health() -> String
  "ok"

fn show_user(params: UserParams) -> Result<UserDto, AppError>
  users::find(params.id)
```

The framework turns the return value into `std::http::Response`.

### Effects Stay Honest

The framework must not erase application effects behind an ambient runtime.
It also should not require every handler to spell out effects that Voyd can
infer.

Most route handlers should be able to rely on inference:

```voyd
fn show_user(params: UserParams) -> Result<UserDto, AppError>
  users::find(params.id)
```

When the docs need to explain capability flow, they can show the inferred row
explicitly:

```voyd
fn show_user(params: UserParams): Db -> Result<UserDto, AppError>
  users::find(params.id)
```

Here `Db` is a user-defined application effect, not a framework effect. A route
tree containing that handler should infer and require `Db` at the serving
boundary whether the handler wrote the row explicitly or not. `Log` is similar
from the framework's perspective even though it comes from `std::log`: it should
remain visible as a required capability instead of being hidden in `Context`.
Framework-owned effects should stay narrow: build-time route registration and
host HTTP serving.

### Handler Types Describe Extraction

Route declarations should infer ordinary request data from typed handler
parameters:

```voyd
get("/users/:id") do(params: UserParams, query: UserQuery):
  load_user(id: params.id, verbose: query.verbose)
```

Use labels when they configure behavior, select a format, or resolve ambiguity:

- `body: json()`
- `body: text()`
- `auth: required_session()`
- `auth: optional_session()`
- `timeout:`
- `limit:`
- `method:`

This keeps request shape in normal Voyd types while keeping request handling
policy visible at the route declaration instead of hiding it in an untyped
middleware chain.

### Structural DTOs For Data, Nominal Types For Behavior

Use structural types for route-shaped data:

```voyd
type SearchQuery = {
  q: String,
  page: i32
}
```

Use nominal types for policies, routers, apps, and contexts:

```voyd
pub obj JsonBody { ... }
pub obj RequiredSession { ... }
pub obj Router { ... }
pub obj Context { ... }
```

That split uses Voyd's hybrid type system in a way that matches the problem.

## Package Shape

Recommended package:

- source: `packages/web`
- import path: `pkg::web`

Recommended public modules:

- `pkg::web::all`
- `pkg::web::router`
- `pkg::web::extract`
- `pkg::web::response`
- `pkg::web::middleware`
- `pkg::web::html`
- `pkg::web::static_files`

`all` should be convenient but not enormous. Advanced escape hatches should stay
in their owning modules.

## Route DSL

The primary documented API should be a trailing-callback DSL.

```voyd
serve(port: 3000) routes():
  get("/health") do:
    "ok"

  post(
    "/sessions",
    body: json(),
    auth: optional_session()
  ) do(input: LoginInput, session: Option<Session>):
    create_session(input, existing: session)
```

Recommended top-level functions:

- `serve({ port, host?, shutdown_timeout?, routes })`
- `get(path, ...)`
- `post(path, ...)`
- `put(path, ...)`
- `patch(path, ...)`
- `delete(path, ...)`
- `route(path, method: Method, ...)`
- `group(prefix, routes:)`
- `adopt(middleware)`
- `not_found(handler)`
- `on_error(handler)`

Prefer the route DSL in examples and docs. Keep the builder API available for
composition, generated code, and cases where explicit app values read better.

## Route Registration Effect

The clean DSL can be implemented as a build-time effect. This is a good use of
Voyd effects: route declarations are not runtime I/O, but they are scoped
capability-like operations during app construction.

Sketch:

```voyd
eff AppBuild
  add_route(tail, route: RouteDefinition) -> void
  add_middleware(tail, middleware: MiddlewareDefinition) -> void
  group(tail, { prefix: String, routes build: fn() : (AppBuild, open) -> void }) -> void
```

DSL helpers are thin wrappers:

```voyd
pub fn get(path: StringSlice, handler: Handler): AppBuild -> void
  AppBuild::add_route(RouteDefinition::get(path, handler))

pub fn group(
  prefix: StringSlice,
  { routes build: fn() : (AppBuild, open) -> void }
): (AppBuild, open) -> void
  AppBuild::group(prefix: prefix.to_string(), routes: build)
```

`serve` handles `AppBuild`, creates a router, then runs it through
`std::http::server`.

This should remain an implementation technique. From the user's perspective,
route declarations should feel like ordinary Voyd calls with trailing closures.

## Builder API

The secondary builder surface should mirror the DSL:

```voyd
let app = web::app()
  .adopt(request_logger)
  .get("/health", handler: health)
  .group("/users") routes(router):
    router.get("/:id", handler: show_user)

web::serve(app, port: 3000)
```

Recommended primitives:

- `web::app() -> App`
- `web::router() -> Router`
- `App::adopt(self, middleware) -> App`
- `App::get(self, path, ...) -> App`
- `App::post(self, path, ...) -> App`
- `App::route(self, path, method: Method, ...) -> App`
- `App::group(self, prefix, build:) -> App`
- `App::mount(self, prefix, router) -> App`
- `App::handle(self, request: IncomingRequest) -> Response`
- `web::serve(app, { port, host? })`

The builder should be immutable by default. Mutating variants can be explicit if
performance or generated code needs them.

## Handlers

Canonical handler style:

```voyd
fn show_user(params: UserParams, query: UserQuery) -> Result<UserDto, AppError>
  users::find(params.id)
```

The framework should support three ergonomic shapes:

```voyd
get("/health") do:
  "ok"

get("/users/:id") do(params: UserParams):
  users::find(params.id)

get("/debug") do(ctx: Context):
  ctx.request
```

Rules:

- handler parameter names and types choose extractors
- explicit route labels configure policies and resolve ambiguous handler shapes
- `ctx: Context` may be requested as the final parameter
- handler return type only needs to implement `IntoResponse`
- handler effects remain part of the surrounding app effect row

## Effect-Polymorphic Handler Contracts

The proposal should not use pure function aliases for effectful callbacks.
Handlers and middleware need open effect rows. A route handler also should not
be forced through a single `fn(Context) -> Response` shape before typing, because
its typed parameters are part of the extraction contract.

Conceptual shape:

```voyd
pub type Next =
  fn(Context) : (open) -> http::Response

pub type Middleware =
  fn(Context, next: Next) : (open) -> http::Response
```

Each route can keep its ordinary typed handler during type checking, derive an
extraction plan from the handler parameter list, and only then wrap it in an
internal erased representation for router storage.

The exact generic encoding may need an implementation spike, especially because
routes with different extractors, handler arities, and effects are stored
together. The design requirement is clear:

- route registration remains effect-polymorphic
- middleware can perform effects
- `next(ctx)` preserves downstream effects
- `serve(...)` exposes the union of required application effects

If the first implementation needs an internal type-erased wrapper, the wrapper
should be an implementation detail created after type-checking each route's
ordinary handler.

## Extractors

Extractors are where Voyd can feel meaningfully better than Express. They make
request shape and policy explicit without turning the request into a dynamic
bag.

Recommended route declarations should infer extraction from handler parameter
names and types:

```voyd
get("/users/:id") do(params: UserParams, query: UserQuery, headers: RequestHeaders, ctx: Context):
  ...

post(
  "/users",
  body: json(),
  auth: required_session(),
  timeout: Duration::from_millis(500)
) do(input: CreateUser, session: Session, ctx: Context):
  ...
```

These examples are call sites. The `get` and `post` definitions should use
ordinary labeled parameter groups with `{ ... }` for route policy and a trailing
callback for the handler. The framework should inspect the typed handler
signature after type checking to build the extraction plan.

This requires typed trailing callback clause parameters such as
`do(params: UserParams):`. If the current parser only accepts untyped clause
heads, the framework proposal should include the small language/compiler change
to support typed callback clause parameters. Named handler functions can be a
Phase 1 fallback because their parameter types are already available from the
function signature.

### Extractor Kinds

Initial inferred handler parameters:

- `params: T`
- `query: T`
- `headers: T`
- `ctx: Context`

Initial route policies that supply handler parameters:

- `body: json()` plus one typed body parameter
- `body: text()` plus one `String` body parameter
- `body: bytes()` plus one `Bytes` body parameter
- `auth: required_session()` plus one `Session` parameter
- `auth: optional_session()` plus one `Option<Session>` parameter

Later extractors:

- `body: form()` plus one typed body parameter
- `body: multipart(...)`
- `cookies: T`
- `state: AppState`
- `limit: body_limit(...)`

Parameter names should be part of the matching rules because structural data
often overlaps. A parameter named `params` maps to path params; `query` maps to
query; `headers` maps to request headers; `ctx` maps to `Context`. Body and auth
parameters are matched by the explicit route policy that introduces them. If a
handler shape is ambiguous, the compiler should produce a targeted diagnostic
asking for a route label, a parameter rename, or an explicit wrapper type.

### Extractor Traits

Use traits to keep extraction extensible.

```voyd
pub trait FromParams<T>
  fn from_params(params: RouteParams) -> Result<T, Rejection>

pub trait FromQuery<T>
  fn from_query(query: QueryParams) -> Result<T, Rejection>

pub trait FromBody<T>
  fn from_body(ctx: Context) -> Result<T, Rejection>

pub trait FromHeaders<T>
  fn from_headers(headers: http::Headers) -> Result<T, Rejection>
```

Structural records are ideal targets for params and query because names matter
more than identity:

```voyd
type UserParams = {
  id: String
}

type PageQuery = {
  page: i32,
  include_archived: bool
}
```

Nominal policy values are better for behavior:

```voyd
pub obj JsonBody { ... }
pub obj RequiredSession { ... }
```

### Extractor Failure Semantics

Extractor failures should short-circuit before the handler runs.

Default mapping:

- path params missing or invalid: `404` or `400`, depending on whether the route
  matched
- query parse failure: `400`
- JSON parse failure: `400`
- body too large: `413`
- unsupported content type: `415`
- auth required but absent: `401`
- auth present but insufficient: `403`

Each extractor should return a `Rejection` that implements `IntoResponse`, so
applications can override formatting consistently.

## Context

`Context` should be small and predictable. It is requested explicitly with a
`ctx: Context` handler parameter and should act as an escape hatch and
middleware carrier, not as the main way to access application capabilities.

```voyd
pub obj Context {
  api request: http::IncomingRequest,
  api route: MatchedRoute
}
```

Recommended helpers:

- `ctx.method() -> Method`
- `ctx.path() -> String`
- `ctx.header(name) -> Option<String>`
- `ctx.param(name) -> Option<String>`
- `ctx.query_value(name) -> Option<String>`
- `ctx.body_bytes() -> Bytes`
- `ctx.text() -> Result<String, BodyError>`
- `ctx.json() -> Result<JsonValue, BodyError>`

Avoid a dynamic `locals` bag as the primary design. If an escape hatch is needed,
make it visibly secondary, for example `ctx.extensions()`, and do not use it in
core examples.

## Responses

The canonical response type is `std::http::Response`.

The framework should re-export it:

```voyd
pub use std::http::Response
```

Response builders live on the canonical response type:

```voyd
Response::ok()
  .with(header: "cache-control", value: "no-store")
  .text("hello")

Response::created().json(user)
Response::no_content()
```

Because `Response` is owned by `std::http`, framework-specific helpers such as
generic DTO JSON and VX HTML can be provided as extension-style free functions
with `Response` as their first parameter. With `pkg::web::all` imported, users
should still be able to write natural dot-call code such as
`Response::ok().json(user)` and `Response::ok().html(page)`.

Recommended builders:

- `Response::ok()`
- `Response::created()`
- `Response::no_content()`
- `Response::bad_request()`
- `Response::unauthorized()`
- `Response::forbidden()`
- `Response::not_found()`
- `Response::internal_server_error()`
- `with(status:)`
- `with(header:)`
- `with(header:, value:)`
- `with(headers:)`
- `with(body:)`
- `with(cookie:)`
- `text(value)`
- `json(value)`
- `bytes(value)`
- `html(value)`

`html` can be provided by `pkg::web::html` if std should stay free of VX
dependencies.

## `IntoResponse`

Use a trait to make handlers concise.

```voyd
pub trait IntoResponse
  fn into_response(self) -> http::Response
```

Initial implementations:

- `http::Response`
- `String`
- `StringSlice`
- `Bytes`
- `JsonValue`
- `vx::Html<Msg>` or the current VX node type
- `(Status, String)`
- `(Status, JsonValue)`
- `(Status, Bytes)`
- `Result<T, E>` where `T: IntoResponse` and `E: IntoResponse`
- `Option<T>` where `T: IntoResponse`, mapping `None` to `404`

For ordinary DTO-compatible objects, the desired DevX is:

```voyd
fn show_user(params: UserParams) -> Result<UserDto, AppError>
  users::find(params.id)
```

and the framework returns JSON without the user manually constructing
`JsonValue` or `MsgPack`.

To support that cleanly, the framework needs a stable DTO-to-JSON path. If the
language/runtime already exposes boundary-compatible serialization for a type,
the framework should use that machinery behind the scenes. If not, Phase 1 can
support `JsonValue` and explicit JSON encoders while reserving the API shape for
generic DTO responses.

The important rule: do not expose MessagePack as the response authoring model.

## JSON DevX

Route authors should be able to choose the level of explicitness:

```voyd
get("/version") do:
  VersionDto { version: "0.3.0" }

get("/status") do:
  Response::ok().json(StatusDto { healthy: true })

post("/users", body: json()) do(input: CreateUser):
  create_user(input)
```

The framework should default DTO-compatible object returns to JSON, while
strings remain `text/plain` and bytes remain `application/octet-stream`.

If default JSON for arbitrary objects proves too implicit, keep the concise
alternative:

```voyd
get("/version") do:
  json(VersionDto { version: "0.3.0" })
```

That still keeps users away from low-level encoding.

## HTML And VX

Server-rendered HTML should use `std::vx` as the authoring model.

```voyd
use std::vx
use pkg::web::Response

fn home_page(name: String) -> vx::Html<AppMsg>
  <main>
    <h1>Voyd Web</h1>
    <p>Hello, {name}</p>
  </main>

fn home() -> Response
  Response::ok().html(home_page("friend"))
```

Recommended helpers:

- `html::render(value) -> String`
- `html::document(value) -> String`
- `Response::html(value) -> Response`

The framework should treat HTML syntax as the primary authoring path. Users
should not hand-assemble render trees unless they want to.

Future VX improvements can make the render tree more nominal and less raw
internally. The web framework should hide those details either way.

### VX Hydration

Static server-rendered HTML should remain the simplest path, but the framework
should leave room for hydratable VX apps. A server route should be able to
render the initial document and attach enough boot metadata for a browser-side
VX runtime to hydrate the same app without authors hand-writing host interop.

Conceptual API shape:

```voyd
fn home(model: HomeModel) -> Response
  Response::ok().html(
    html::document(
      view: home_page(model),
      hydrate: html::hydrate(
        target: "#app",
        entry: "/assets/home.js",
        model: model
      )
    )
  )
```

Hydration should be opt-in. The initial model should be a normal DTO-compatible
value, with any encoding details hidden by the framework/runtime. Server effects
used to render the first response and browser effects used after hydration
should stay separate so the server route does not appear to require browser-only
capabilities.

## Middleware

Middleware should be ordinary value-returning Voyd code.

```voyd
fn request_logger(ctx: Context, next: Next): Log -> Response
  log::info("request.started")
  let response = next(ctx)
  log::info("request.finished")
  response

fn require_api_key(ctx: Context, next: Next): Response
  match(ctx.header("x-api-key"))
    Some<String> { value }:
      if value == "secret" then:
        next(ctx)
      else:
        Response::unauthorized().text("invalid api key")
    None:
      Response::unauthorized().text("missing api key")
```

Middleware registration:

```voyd
serve(port: 3000) routes():
  adopt(request_logger)

  adopt() do(ctx, next):
    match(ctx.header("x-request-id"))
      Some<String>:
        next(ctx)
      None:
        Response::bad_request().text("missing request id")
```

Middleware ordering should be deterministic:

- outer `adopt` runs before routes in its scope
- group middleware wraps routes inside the group
- route-local policies and inferred extractors run before the handler
- `next(ctx)` decides whether downstream middleware and the handler run

Typed auth and body policy should prefer handler parameters over middleware
when the handler needs the resulting value.

## Routing Semantics

Define routing behavior precisely.

Recommended defaults:

- routes match method and path
- route params use `:name`
- params are percent-decoded
- query strings are parsed separately from paths
- static segments outrank param segments
- params outrank wildcard segments if wildcards are added later
- declaration order resolves ties
- unmatched path returns `404`
- matched path with wrong method returns `405`
- trailing slash behavior is explicit and configurable

Examples:

```voyd
serve(port: 3000) routes():
  get("/users") do:
    list_users()

  get("/users/:id") do(params: UserParams):
    show_user(params.id)

  route("/posts/:id", method: Method::Delete {}) do(ctx: Context):
    delete_post(ctx.param("id").unwrap_or(""))
```

## Errors

Prefer typed errors over one global exception-like channel.

`Result<T, E>` should be a first-class handler return shape when both `T` and
`E` implement `IntoResponse`:

```voyd
obj AppError {
  api message: String,
  api status: Status
}

impl IntoResponse for AppError
  fn into_response(self) -> Response
    Response::new(status: self.status).json(ErrorDto { message: self.message })

fn show_user(params: UserParams) -> Result<UserDto, AppError>
  users::find(params.id)
```

Framework-level error hooks are still useful:

- formatting extractor rejections
- logging unexpected host errors
- converting panics/traps where the runtime can report them
- customizing default `404` and `405` responses

```voyd
serve(port: 3000) routes():
  not_found() do(ctx: Context):
    Response::not_found().html(not_found_page(ctx.path()))

  on_rejection() do(rejection: Rejection, ctx: Context):
    rejection.into_response().with(header: "x-error", value: "request")
```

## Tasks, Timeouts, And Cancellation

Request concurrency should use `std::task` and `std::time`.

This example writes the effect row explicitly to show the capabilities involved;
ordinary handlers may rely on inference when that reads better.

```voyd
fn dashboard(ctx: Context): (TaskRuntime, Time, Db) -> Result<DashboardDto, AppError>
  let stats_task = task::spawn do:
    load_stats()

  let activity_task = task::spawn do:
    load_recent_activity()

  match(stats_task.await())
    Ok<Stats> { value: stats }:
      match(activity_task.await())
        Ok<Activity> { value: activity }:
          Ok<DashboardDto> {
            value: DashboardDto { stats: stats, activity: activity }
          }
        Err<TaskError> { error }:
          Err<AppError> { error: AppError::task(error) }
        Cancelled:
          Err<AppError> { error: AppError::cancelled() }
    Err<TaskError> { error }:
      Err<AppError> { error: AppError::task(error) }
    Cancelled:
      Err<AppError> { error: AppError::cancelled() }
```

Route-level timeout policy should be explicit:

```voyd
get("/dashboard", timeout: Duration::from_millis(500)) do(ctx: Context):
  dashboard(ctx)
```

The timeout implementation can be a framework policy built on `std::task` and
`std::time`. It should not require a hidden async runtime object in the handler.

## Static Files

Static files should be an optional framework layer.

```voyd
serve(port: 3000) routes():
  adopt(web::serve_dir("/public"))
```

This layer should use `std::fs`, `std::path`, `Bytes`, and `Headers` under the
hood. MIME type lookup can start in the framework package.

Static files should not be part of the core router's minimum dependency set.

## Low-Level Escape Hatches

Users should be able to drop down without leaving the framework.

Recommended escape hatches:

- `App::handle(request: IncomingRequest) -> Response`
- `Context::request`
- `Response::new(...)`
- `body: bytes()`
- `route(path, method:)`
- direct `std::http::server` usage for custom loops

Escape hatches should still use the canonical `std::http` types.

## Phasing

### Phase 1: Core Framework

- depend on `std::http` and `std::http::server`
- implement route DSL and builder API
- implement method/path routing, groups, and middleware ordering
- implement `IntoResponse` for core types
- implement params/query/body extractors
- support `JsonValue` and explicit JSON response helpers
- support static HTML responses through current `std::vx` server rendering
- keep the HTML response shape compatible with future VX hydration helpers
- add smoke coverage for public request/response serving

### Phase 2: World-Class DevX

- generic DTO-to-JSON response conversion
- opt-in VX SSR hydration helpers for initial models, mount targets, and client
  entries
- typed auth/session extractors
- typed cookies
- route-level timeout/body-limit policies
- better rejection customization
- static-file layer
- SDK helper for serving a web app from Node

### Phase 3: Advanced Server Features

- streaming request and response bodies
- multipart forms
- WebSocket or server-sent events if the effect model supports them cleanly
- richer content negotiation
- OpenAPI/schema generation from route declarations if DTO reflection supports it

## Testing Direction

Follow `docs/testing/test-layer-ownership.md`.

- `packages/web`: route matching, middleware ordering, extractor behavior,
  `IntoResponse`, error/rejection mapping
- `packages/std`: HTTP values, client wrappers, server wrappers
- `packages/js-host`: HTTP server capability lifecycle
- `apps/smoke`: end-to-end public app serving

Use a small number of compile-heavy smoke fixtures. Put focused router and
extractor tests in `packages/web`.

## Recommendation

Build `packages/web` as a typed, value-returning router layer on top of
`std::http`. Use effects for capabilities, labels for extraction and policy,
structural DTOs for request data, nominal types for behavior, and `IntoResponse`
for ergonomic return values.

The framework should make simple routes feel effortless while preserving the
explicit capability story that makes Voyd different.
