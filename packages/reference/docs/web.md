---
order: 9
---

# Web

The `pkg::web` package is Voyd's HTTP application framework. It builds on
`std::http` and gives you routing, middleware, typed request extraction,
response conversion, static-file middleware, and server-side HTML helpers.

Use the web framework when you want to write HTTP handlers as ordinary Voyd
functions that return ordinary values. The framework owns the route table and
request pipeline; `std::http` still owns the underlying request and response
types.

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/health") do:
      "ok".as_slice().to_string()
```

Most applications should import `pkg::web::all`. Larger packages can import
from the narrower modules:

- `pkg::web::router` for `App`, `Router`, `Context`, middleware, and serving.
- `pkg::web::routes` for builder-style route helper functions.
- `pkg::web::extract` for body, auth, params, query, headers, and rejections.
- `pkg::web::response` for `IntoResponse`, `to_response`, and response helpers.
- `pkg::web::html` for VX server rendering.
- `pkg::web::static_files` for `serve_dir`.

## Routes

Routes are declared inside `serve(...) routes():` or inside `build_app do(...)`.
Use HTTP verb helpers for common routes and `route(..., method:)` when the
method is dynamic or uncommon.

```voyd
use pkg::web::all
use std::http::Method
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000, host: "127.0.0.1", shutdown_timeout: 250) routes():
    get("/health") do:
      "ok".as_slice().to_string()

    post("/events") do(ctx: Context):
      ctx
      status(code: 202, reason: "Accepted".as_slice()).empty()

    route("/resource", method: Method::Delete {}) do:
      Response::ok().text("deleted".as_slice())
```

Path segments that begin with `:` are path parameters.

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::string::type::String
use std::task

type UserParams = {
  id: String
}

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/users/:id") do(params: UserParams):
      params.id
```

Static routes are preferred over parameterized routes when both match. For
example, `/users/new` wins over `/users/:id` even if the parameterized route was
registered first.

```voyd
serve(port: 3000) routes():
  get("/users/:id") do(params: UserParams):
    Response::ok().text(params.id)

  get("/users/new") do:
    Response::ok().text("new".as_slice())
```

Group related routes with a prefix. Middleware adopted before a group applies
inside the group; middleware adopted inside the group stays scoped to that
group.

```voyd
serve(port: 3000) routes():
  group("/api") routes():
    get("/health") do:
      "ok".as_slice().to_string()

    group("/users") routes():
      get("/:id") do(params: UserParams):
        params.id
```

## Handlers

Handlers return values. They do not receive a mutable response writer. The
framework converts supported values with `IntoResponse`.

```voyd
get("/text") do:
  "hello".as_slice().to_string()

get("/raw") do:
  Response::ok().text("already a response".as_slice())

get("/created") do:
  (Status::created(), "created".as_slice().to_string())
```

Useful return shapes include:

- `Response`, returned unchanged.
- `String` and `StringSlice`, returned as `200 OK` text.
- `Bytes`, returned as `200 OK` bytes.
- `JsonValue`, returned as `200 OK` JSON.
- `(Status, String)`, `(Status, StringSlice)`, `(Status, Bytes)`, and
  `(Status, JsonValue)`.
- `Result<T, E>` when both `T` and `E` can become a response.
- `Option<T>`, where `None` becomes `404 Not Found`.

```voyd
use pkg::web::all
use std::json::{ JsonBool, JsonValue }
use std::optional::types::all
use std::result::types::all
use std::string::type::String

fn feature_flag() -> JsonValue
  JsonBool { value: true }

fn find_name(id: String) -> Option<String>
  if id.equals("1") then:
    Some<String> { value: "Ada".as_slice().to_string() }
  else:
    None {}

fn create_name(name: String) -> Result<(Status, String), Rejection>
  if name.is_empty() then:
    Err<Rejection> { error: Rejection::bad_request("missing name".as_slice()) }
  else:
    Ok<(Status, String)> { value: (Status::created(), name) }

serve(port: 3000) routes():
  get("/flag") do:
    feature_flag()

  get("/users/:id") do(params: UserParams):
    find_name(params.id)

  post("/users", body: text_body()) do(input: String):
    create_name(input)
```

Use `response_json(...)` when you want to create a JSON response explicitly.
The shorter `json()` name is reserved in `pkg::web::all` for the JSON body
policy, so `response_json(...)` is the clearest root-level response helper.

```voyd
let value: JsonValue = JsonBool { value: true }
let response = response_json(value)
```

## Context

Request handlers can ask for `ctx: Context` when they need the raw request,
headers, path values, query values, or explicit rejection handling.

```voyd
get("/inspect/:id") do(ctx: Context):
  let id = ctx.param("id".as_slice()) ?? "missing".as_slice().to_string()
  let mode = ctx.query_value("mode".as_slice()) ?? "default".as_slice().to_string()
  Response::ok().text(id.concat(":".as_slice()).concat(mode))
```

Common `Context` methods:

- `ctx.method()` returns the request `Method`.
- `ctx.path()` returns the request path.
- `ctx.header(name)` returns an optional header value.
- `ctx.param(name)` returns an optional path parameter.
- `ctx.query()` returns all parsed query parameters.
- `ctx.query_value(name)` returns one query value.
- `ctx.body_bytes()` returns the raw request body bytes.
- `ctx.text()` reads the request body as text.
- `ctx.json()` reads the request body as `JsonValue`.
- `ctx.reject(rejection)` runs the current rejection handler.

## Params, Query, And Headers

The DSL uses handler parameter names to decide which extractor to use:

- `params: T` decodes path parameters into `T`.
- `query: T` decodes the query string into `T`.
- `headers: T` decodes request headers into `T`.
- `ctx: Context` passes the full request context.

Use structural types for request-shaped data.

```voyd
use pkg::web::all
use std::string::type::String

type SearchParams = {
  org: String
}

type SearchQuery = {
  q: String,
  page: i32,
  exact: bool
}

type RequestHeaders = {
  authorization: String
}

serve(port: 3000) routes():
  get("/orgs/:org/search") do(
    params: SearchParams,
    query: SearchQuery,
    headers: RequestHeaders,
    ctx: Context
  ):
    let request_id = ctx.header("x-request-id".as_slice()) ?? "missing".as_slice().to_string()
    Response::ok().text(
      params.org
        .concat(":".as_slice())
        .concat(query.q)
        .concat(":".as_slice())
        .concat(headers.authorization)
        .concat(":".as_slice())
        .concat(request_id)
    )
```

Path params and headers decode as strings. Query values decode booleans from
`true` and `false`, integers from canonical integer strings, and all other
values as strings.

Use the explicit `route_*` helpers in builder-style code when the parameter
shape cannot be inferred from a free route helper name.

```voyd
let app = build_app do(base):
  route_query_context(base, "/search".as_slice(), method: Method::Get {}) do(
    query: SearchQuery,
    _ctx: Context
  ):
    if query.exact then:
      Response::ok().text("exact".as_slice())
    else:
      Response::ok().text("fuzzy".as_slice())
```

## Request Bodies

Body policies are explicit route labels. Use `json_body()` for typed JSON,
`text_body()` for text, and `bytes()` for raw bytes.

```voyd
use pkg::web::all
use std::bytes::Bytes
use std::string::type::String

type CreateUser = {
  name: String,
  active: bool
}

serve(port: 3000) routes():
  post("/users", body: json_body()) do(input: CreateUser):
    Response::created().text(input.name)

  post("/echo", body: text_body()) do(input: String):
    Response::ok().text(input)

  put("/upload", body: bytes()) do(input: Bytes):
    Response::ok().bytes(input)
```

`json_body()` accepts `application/json` and media types ending in `+json`.
When the content type is not JSON, the route rejects with `415 Unsupported
Media Type`. Invalid body text or invalid JSON rejects with `400 Bad Request`.

The concise aliases `json()` and `text()` are also available for body policies,
but `json_body()` and `text_body()` read better in route declarations because
`json` and `text` are common response concepts too.

## Auth

Auth is also an explicit route label. The default `required_session()` and
`optional_session()` policies read the `authorization` header.

```voyd
use pkg::web::all
use std::optional::types::all
use std::string::type::String

serve(port: 3000) routes():
  get("/me", auth: required_session()) do(session: String):
    Response::ok().text(session)

  get("/maybe-me", auth: optional_session()) do(session: Option<String>):
    match(session)
      Some<String> { value }:
        Response::ok().text(value)
      None:
        Response::unauthorized().empty()
```

Use a custom `AuthPolicy<T>` when your application has a typed session value.
The extractor can perform effects because `AuthExtractor<T>` has an open effect
row.

```voyd
use pkg::web::all
use std::http::IncomingRequest
use std::result::types::all
use std::string::type::String

obj Session {
  api user_id: String,
  api role: String
}

fn extract_session(request: IncomingRequest) -> Result<Session, Rejection>
  match(request.header("authorization".as_slice()))
    Some<String> { value }:
      Ok<Session> {
        value: Session { user_id: value, role: "member".as_slice().to_string() }
      }
    None:
      Err<Rejection> { error: Rejection::unauthorized("missing auth".as_slice()) }

serve(port: 3000) routes():
  get(
    "/account",
    auth: required_session<Session>(extract: extract_session)
  ) do(session: Session):
    Response::ok().text(session.user_id)
```

## Middleware

Middleware receives a `Context` and `next`. It returns a `Response`. Call
`next(ctx)` to continue to the next middleware or the matched route handler, or
return a response early.

```voyd
use pkg::web::all
use std::http::Response
use std::optional::types::all
use std::string::type::String

fn require_request_id(ctx: Context, next: Next) -> Response
  match(ctx.header("x-request-id".as_slice()))
    Some<String>:
      next(ctx)
    None:
      Response::bad_request().text("missing request id".as_slice())

serve(port: 3000) routes():
  adopt(require_request_id)

  get("/health") do:
    "ok".as_slice().to_string()
```

Middleware is ordered by registration. Middleware adopted before a route applies
to that route. Middleware adopted later does not affect earlier routes.

```voyd
serve(port: 3000) routes():
  get("/public") do:
    "public".as_slice().to_string()

  adopt(require_request_id)

  get("/private") do:
    "private".as_slice().to_string()
```

The package includes `request_id_required`, which rejects requests that do not
include `x-request-id`.

```voyd
serve(port: 3000) routes():
  adopt(request_id_required)
  get("/work") do:
    Response::ok().empty()
```

## Errors And Rejections

Route matching failures and extractor failures are handled separately.

- No matching path returns the not-found handler.
- A matching path with the wrong method returns the method-not-allowed handler.
- Body, auth, params, query, and header extraction failures produce a
  `Rejection`.
- `on_error` and `on_rejection` both install an `ErrorHandler`.

```voyd
serve(port: 3000) routes():
  not_found() do(ctx: Context):
    ctx
    Response::not_found().text("custom 404".as_slice())

  method_not_allowed() do(ctx: Context):
    ctx
    Response::method_not_allowed().text("custom method".as_slice())

  on_rejection() do(rejection: Rejection, ctx: Context):
    ctx
    Response::new(status: rejection.status).text(rejection.message)

  post("/json", body: json_body()) do(input: CreateUser):
    Response::ok().text(input.name)
```

Return `Result<T, Rejection>` from handlers when normal application validation
should use the same response shape as extraction failures.

```voyd
fn validate_name(input: CreateUser) -> Result<CreateUser, Rejection>
  if input.name.is_empty() then:
    Err<Rejection> { error: Rejection::bad_request("name is required".as_slice()) }
  else:
    Ok<CreateUser> { value: input }

post("/users", body: json_body()) do(input: CreateUser):
  match(validate_name(input))
    Ok<CreateUser> { value }:
      Response::created().text(value.name)
    Err<Rejection> { error }:
      error
```

## Static Files

Use `serve_dir(root)` as middleware. It serves `GET` and `HEAD`, prevents
`..` path traversal, serves `index.html` for `/`, and falls through to `next`
when the file is missing or cannot be read.

```voyd
use pkg::web::all

serve(port: 3000) routes():
  adopt(serve_dir("./public".as_slice()))

  get("/api/health") do:
    "ok".as_slice().to_string()
```

Static files infer common content types for `.html`, `.css`, `.js`, `.json`,
`.png`, `.jpg`, `.jpeg`, and `.svg`. Other files use
`application/octet-stream`.

Place static middleware before dynamic fallback routes when files should win.
Place it after API routes when the API should win.

```voyd
serve(port: 3000) routes():
  get("/api/health") do:
    "ok".as_slice().to_string()

  adopt(serve_dir("./public".as_slice()))

  get("/:slug") do(params: PageParams):
    render_page(params.slug)
```

## HTML Responses

`pkg::web::html` renders `std::vx` HTML values to strings for server-side
responses. Use `html_response` or the `html` alias to attach
`text/html; charset=utf-8`.

```voyd
use pkg::web::all
use std::vx::all

fn home() -> Response
  html_response(
    Response::ok(),
    <main>
      <h1>Voyd</h1>
      <p>Hello from the server.</p>
    </main>
  )

serve(port: 3000) routes():
  get("/") do:
    home()
```

Use `render(...)` when you need the HTML string and `document(...)` when you
want a complete document string with `<!doctype html>`.

```voyd
let body = render(<span>Saved</span>)
let full = document(
  <html>
    <body>
      <h1>Saved</h1>
    </body>
  </html>
)
```

## Builder API

The route DSL is the default surface for applications. The builder API is useful
for generated routes, package-level composition, and tests.

```voyd
use pkg::web::all
use std::http::Response

fn health() -> Response
  Response::ok().text("ok".as_slice())

let web_app = app()
  .get_unit("/health".as_slice(), handler: health)
  .get("/debug".as_slice(), handler: (ctx: Context) -> Response =>
    Response::ok().text(ctx.path())
  )
```

Use explicit builder method names for extracted handler shapes. The names make
the extracted data visible and avoid ambiguous same-name overloads for inline
lambdas.

```voyd
let web_app = app()
  .get_params("/users/:id".as_slice(), handler: (params: UserParams) -> Response =>
    Response::ok().text(params.id)
  )
  .get_params_query(
    "/users/:id/activity".as_slice(),
    handler: (params: UserParams, query: UserQuery) -> Response =>
      let verbose = if query.verbose then: "true".as_slice().to_string() else: "false".as_slice().to_string()
      Response::ok().text(params.id.concat(":".as_slice()).concat(verbose))
  )
```

`build_app` gives builder helpers a threaded `AppBuild` value.

```voyd
let web_app = build_app do(base):
  let with_health = get_context(base, "/health".as_slice()) do(_ctx: Context):
    Response::ok().text("ok".as_slice())

  let with_item = get(with_health, "/items/:id".as_slice()) do(params: UserParams):
    Response::ok().text(params.id)

  post(
    with_item,
    "/echo".as_slice(),
    body: text_body(),
    handler: (input: String) -> Response => Response::ok().text(input)
  )
```

`Router` wraps an `App` for reusable subrouters. Import the module when you need
the constructor, then call `router::Router::init()`.

```voyd
use pkg::web::all
use pkg::web::router

let api = router::Router::init()
  .get_unit("/health".as_slice(), handler: () -> Response =>
    Response::ok().text("router".as_slice())
  )

let web_app = app().mount("/api".as_slice(), api)
```

The package root reserves `pkg::web::router` for the module path, so there is no
root-level `web::router()` constructor. This keeps imports predictable when a
module and function would otherwise share the same package-boundary name.

## Serving

Use `serve(...) routes():` for the shortest application entrypoint.

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/health") do:
      "ok".as_slice().to_string()
```

Use `serve(app, port:)` or `serve_app(...)` when you already have an `App`.

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

fn make_app() -> App
  app().get_unit("/health".as_slice(), handler: () -> Response =>
    Response::ok().text("ok".as_slice())
  )

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(make_app(), port: 3000)
```

Use `serve_build(...)` when you want build-style composition and server options
in one call.

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve_build(port: 3000, host: "127.0.0.1") do(base):
    get_unit(base, "/health".as_slice()) do:
      "ok".as_slice().to_string()
```

`serve` is backed by `std::http::server`, so the surrounding function must
provide the server and task-runtime effects required by that package.
Application-specific effects used by handlers also remain visible in the
entrypoint effect row.

## Developer Notes

The web package intentionally keeps a split between data and behavior:

- Structural records model request data such as params, query, headers, and JSON
  DTO bodies.
- Nominal objects model behavior and policies such as `App`, `Router`,
  `Context`, `JsonBody`, `TextBody`, `RequiredSession`, and `AuthPolicy<T>`.
- Traits are implemented for nominal policy and response types. Do not rely on
  applying traits to structural DTOs.

Route registration stores erased `Handler`, `Middleware`, and `ErrorHandler`
function values internally, but the public route helpers keep typed handler
parameters long enough to derive extraction before wrapping the handler.

When adding a new extractor family:

- Add a nominal policy type when extraction carries behavior.
- Keep route labels explicit for behavior-changing policy, such as `body:` and
  `auth:`.
- Prefer structural input records for decoded request data.
- Add both DSL helpers and builder/helper mirrors when the shape is useful in
  generated or composed code.
- Keep route helper names explicit when inline lambda overload resolution would
  otherwise be ambiguous.

When adding a new response type:

- Implement or reuse `IntoResponse<T>`.
- Add `to_response(...)` overloads for common tuple, result, or option shapes
  only when they improve call-site clarity.
- Keep response helpers in `pkg::web::response`, and re-export root-level names
  from `pkg::web` only when they do not conflict with common policy names.

The framework should not hide effects in ambient state. Handler, middleware,
auth, and body extraction callbacks use open effect rows where appropriate, and
serving exposes the effects required by `std::http::server` and the application
code it runs.
