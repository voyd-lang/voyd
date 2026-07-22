---
order: 9
---

# Web

`pkg::web` is Voyd's HTTP framework. Use it to build JSON APIs,
server-rendered sites, or applications that combine HTTP routes with a VX
client.

This guide starts with ordinary routes and then follows the path of a request:

1. choose a route;
2. decode request data;
3. return a response;
4. handle errors and cross-cutting concerns;
5. optionally publish an OpenAPI description or render VX pages.

Most applications can begin with one import:

```voyd
use pkg::web::all
```

## Start a project

Install the Voyd CLI and scaffold the Web starter:

```bash
npm install -g @voyd-lang/cli
voyd bootstrap my-site --template web-ssr
cd my-site
npm install
npm run dev
```

The starter includes the Node host, development scripts, static assets, and VX
server rendering. It is useful for API-only projects too: keep
`src/main.voyd` and remove the client and hydration code you do not need.

Useful commands:

```bash
npm run dev          # rebuild and restart while editing
npm run voyd:check   # compile-check the Voyd server and client
npm run build        # build production assets and check Voyd
npm start            # run the server
```

The generated host reads `PORT` or `VOYD_WEB_PORT`, and `HOST` or
`VOYD_WEB_HOST`. A deployed server commonly uses:

```bash
HOST=0.0.0.0 PORT=8080 npm start
```

## Minimal server

This is a complete server with two routes:

```voyd
use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000, host: "127.0.0.1") routes():
    get("/") do:
      "Hello from Voyd"

    get("/health") do:
      json({ healthy: true })
```

`serve` starts the HTTP server and builds the routes inside `routes():`.
Because it uses `std::http::server`, the entrypoint declares the HTTP server and
task runtime effects. Effects used by handlers belong in this effect row too.

## Routes

A route has a path, an HTTP method, optional policies, and a handler. The
examples in this section are declarations inside a `serve(...) routes():`
block unless they show a complete server.

### Route parameters

The method helpers share these parameters:

| Parameter | Meaning | Available on |
| --- | --- | --- |
| `path` | URL path to match. Segments beginning with `:` are parameters. | Every route |
| `body` | Body decoder such as `json_body()`, `text_body()`, or `bytes()`. | `post`, `put`, `patch`, `delete`, `route` |
| `limit` | Maximum bytes accepted by that route's body decoder. | Routes with `body` |
| `auth` | Authentication policy whose result is passed to the handler. | Every method helper |
| `timeout` | Handler timeout, usually created with `timeout_millis(...)`. | Every method helper |
| `method` | Explicit `Method` value. | `route` only |

Policies compose:

```voyd
post(
  "/articles",
  body: json_body(),
  limit: body_limit(64 * 1024),
  auth: required_session(),
  timeout: timeout_millis(2000)
) do(input: CreateArticle, session: String):
  json({ title: input.title, author: session })
```

The handler parameters come from the route path and policies. The
[Requests](#requests) section documents each extracted parameter.

### `get`

Use `get` for read-only endpoints. It accepts `path`, plus optional `auth` and
`timeout` policies.

```voyd
get("/articles") do:
  json({ count: 0 })
```

Path parameters begin with `:` and decode into the handler's `params` record:

```voyd
type ArticleParams = {
  slug: String
}

get("/articles/:slug") do(params: ArticleParams):
  json({ slug: params.slug, title: "A Voyd article" })
```

### `post`

Use `post` to create resources or start operations. It accepts `path`, and can
also accept `body`, `limit`, `auth`, and `timeout`.

```voyd
type CreateArticle = {
  title: String,
  published: bool
}

post("/articles", body: json_body()) do(input: CreateArticle):
  Response::created().json(value: {
    title: input.title,
    published: input.published
  })
```

### `put`

Use `put` when the request replaces a resource. It supports the same policies
as `post`.

```voyd
put("/articles/:slug", body: json_body()) do(
  input: CreateArticle,
  ctx: Context
):
  let slug = ctx.param("slug") ?? "missing"
  json({ slug: slug, title: input.title })
```

### `patch`

Use `patch` for a partial update. Optional record fields distinguish omitted
values from required ones.

```voyd
type UpdateArticle = {
  title?: String,
  published?: bool
}

patch("/articles/:slug", body: json_body()) do(
  input: UpdateArticle,
  ctx: Context
):
  let slug = ctx.param("slug") ?? "missing"
  json({ slug: slug, updated: true })
```

### `delete`

Use `delete` to remove a resource. A successful deletion commonly returns
`204 No Content`.

```voyd
delete("/articles/:slug") do(params: ArticleParams):
  params
  Response::no_content().empty()
```

`delete` can decode a body when an API requires one, although bodyless delete
routes are more common.

### `route`

Use `route` for methods without a dedicated helper or when the method is chosen
dynamically. `method` is required; `body`, `limit`, `auth`, and `timeout` remain
available.

```voyd
use std::http::Method

route("/articles", method: Method::Options {}) do:
  Response::no_content()
    .with(header: "allow", value: "GET, POST, OPTIONS")
    .empty()
```

### `group`

`group` adds one path prefix to every nested route. It accepts the prefix and a
`routes():` block. Groups can be nested.

```voyd
group("/api") routes():
  get("/health") do:
    json({ healthy: true })

  group("/articles") routes():
    get("/:slug") do(params: ArticleParams):
      json({ slug: params.slug })
```

Middleware adopted inside a group remains in that group. Middleware adopted
before a group also applies to its routes.

### Matching rules

Static routes take precedence over parameter routes. `/articles/new` therefore
wins over `/articles/:slug`, regardless of declaration order.

Trailing slashes are strict by default. Configure an app directly when
`/about` and `/about/` should be equivalent:

```voyd
let web_app = app()
  .with(trailing_slash: ignore_trailing_slash())
  .get("/about", handler: () => "About")
```

## Requests

Web decodes request data before calling a handler. Fixed request shapes should
use typed handler parameters; `Context` is the escape hatch for dynamic access.

### Handler parameters

Handler parameter names select their source:

| Handler parameter | Value supplied by Web |
| --- | --- |
| `input: T` | Decoded route body selected by the `body` policy |
| `params: T` | Path parameters such as `:slug` |
| `query: T` | URL query parameters |
| `headers: T` | Request headers |
| `cookies: T` | Request cookies |
| `session: T` | Value produced by the route's `auth` policy |
| `ctx: Context` | Full request and route context |

Body routes accept `input`, an optional authentication result, and an optional
final `ctx`. Read path or query values from `ctx` when a body route needs them.

Without a body policy, supported typed combinations include a single extractor;
`params` with `query`; `params` with `headers`; `query` with `headers`; and
`params`, `query`, and `headers`. Any supported shape can add `ctx` last. For an
unusual combination, accept `ctx` and read the values dynamically.

### Path parameters

The record field must match the `:name` in the path:

```voyd
type RevisionParams = {
  slug: String,
  revision: String
}

get("/articles/:slug/revisions/:revision") do(params: RevisionParams):
  json({ slug: params.slug, revision: params.revision })
```

Path parameters decode as strings. A missing or incompatible required field
produces `400 Bad Request` before the handler runs.

### Query parameters

```voyd
type SearchQuery = {
  q: String,
  page: i32,
  exact?: bool
}

get("/search") do(query: SearchQuery, ctx: Context):
  ctx
  json({ query: query.q, page: query.page, exact: query.exact })
```

Query values decode `true` and `false` as booleans, canonical integer strings
as integers, and other values as strings. Optional fields may be omitted.
A query-only handler includes `ctx` last so its shape is unambiguous.

### Headers and cookies

```voyd
type RequestHeaders = {
  authorization: String
}

get("/account") do(headers: RequestHeaders):
  json({ authorization: headers.authorization })
```

```voyd
type SessionCookies = {
  session: String
}

get("/session") do(cookies: SessionCookies):
  json({ session: cookies.session })
```

Header and cookie fields decode as strings. Make a field optional when clients
may omit it.

### JSON bodies

`json_body()` requires `application/json` or a media type ending in `+json`.
It parses the body and decodes it into the handler's `input` type:

```voyd
post("/articles", body: json_body()) do(input: CreateArticle):
  json(input)
```

Malformed JSON or an incompatible value produces `400 Bad Request`. An
unsupported content type produces `415 Unsupported Media Type`.

Limit one route independently of the server-wide body limit:

```voyd
post(
  "/articles",
  body: json_body(),
  limit: body_limit(64 * 1024)
) do(input: CreateArticle):
  json(input)
```

`json_body()` parses requests. `json(value)` creates responses; the names are
intentionally distinct.

### Text and byte bodies

```voyd
use std::bytes::Bytes

post("/echo", body: text_body()) do(input: String):
  Response::ok().text(input)

put("/upload", body: bytes()) do(input: Bytes):
  Response::ok().bytes(input)
```

`text_body()` validates UTF-8. `bytes()` leaves the body uninterpreted.

### Request context

Use `Context` when the shape is dynamic or framework code needs the raw
request:

```voyd
get("/inspect/:id") do(ctx: Context):
  let id = ctx.param("id") ?? "missing"
  let mode = ctx.query_value("mode") ?? "default"
  let session = ctx.cookie("session") ?? "anonymous"
  json({ id: id, mode: mode, session: session })
```

Useful methods include:

- `method()` and `path()`;
- `header(name)`, `param(name)`, `query_value(name)`, and `cookie(name)`;
- `query()` and `cookies()` for all parsed values;
- `body_bytes()`, `text()`, and `json()` for direct body access;
- `reject(rejection)` to use the application's rejection handler.

Direct JSON access returns an untyped `JsonValue`:

```voyd
use std::result::types::all

post("/raw-json") do(ctx: Context):
  match(ctx.json())
    Ok<JsonValue> { value }:
      json_value(value)
    Err<HttpError> { error }:
      Response::bad_request().text(error.message)
```

### HTML forms

A normal HTML form uses `application/x-www-form-urlencoded`. Decode it as text,
then parse the fields:

```voyd
use std::optional::types::all

post("/articles", body: text_body()) do(input: String):
  match(parse_query(input).get("title"))
    Some<String> { value }:
      Response::created().text(value)
    None:
      Response::bad_request().text("title is required")
```

For `method="get"`, use a typed `query: T` handler parameter. Browser
validation does not replace server-side validation.

### Multipart forms

Use `multipart_body()` for `multipart/form-data`. File parts remain bytes:

```voyd
post("/upload", body: multipart_body()) do(form: MultipartForm):
  match(form.get("asset"))
    Some<MultipartPart> { value: asset }:
      asset.body
      Response::ok().text("uploaded")
    None:
      Response::bad_request().text("missing asset")
```

A part exposes its headers, form name, optional filename, optional content
type, and body. `part.text()` performs checked UTF-8 decoding.

## Responses

Handlers return values. Web converts supported values into HTTP responses; a
handler never mutates a shared response object.

### Text, bytes, and status codes

```voyd
get("/hello") do:
  "hello"

post("/articles") do:
  (Status::created(), "created")

delete("/articles/:slug") do(params: ArticleParams):
  params
  Response::no_content().empty()
```

Supported values include:

- `Response`, returned unchanged;
- `String` and `StringSlice`, returned as `200 OK` text;
- `Bytes`, returned as `200 OK` bytes;
- `JsonValue`, returned as `200 OK` JSON;
- `(Status, String)`, `(Status, StringSlice)`, `(Status, Bytes)`, and
  `(Status, JsonValue)`;
- `Result<T, E>` when both branches can become responses;
- `Option<T>`, where `None` becomes `404 Not Found`.

Build a response directly for custom headers:

```voyd
post("/articles") do:
  Response::created()
    .with(header: "location", value: "/articles/first")
    .text("created")
```

### JSON responses

`json(value)` serializes typed records, arrays, and primitives and sets the
`content-type` header:

```voyd
get("/api/articles/:slug") do(params: ArticleParams):
  json({
    slug: params.slug,
    title: "A Voyd article"
  })
```

Start from a `Response` to choose another status or add headers:

```voyd
post("/api/articles", body: json_body()) do(input: CreateArticle):
  Response::created().json(value: input)
```

Use `json_value(value)` only when code already has a `JsonValue`. Use
`result_json(result)` to serialize the successful branch of a `Result`, or
`option_json(option)` to serialize `Some` and return 404 for `None`.

### Content negotiation

`negotiate_content(ctx, supported)` selects the best representation from the
request's `Accept` header, including quality values and wildcards.
`accepts(ctx, media_type)` checks one candidate. `best_match` works directly
with an `Accept` header value. A missing `Accept` header selects the first
supported representation.

### Streaming responses

`stream` opens a response, runs a producer, and closes the body when the
producer returns. Each `write_stream` waits for host backpressure:

```voyd
get("/chunks") do:
  stream(
    Response::ok().with(
      header: "content-type",
      value: "text/plain; charset=utf-8"
    ),
    body: () =>
      let _ = write_stream("first\n")
      let _ = write_stream("second\n")
  )
```

Writes are capped at 16 KiB. Split larger byte values before writing. A failed
write usually means the client disconnected, so long-lived producers should
stop after an error.

### Server-Sent Events

`sse_response` creates the required headers and formats events according to the
SSE wire format:

```voyd
use std::http::server::ResponseWriter

fn publish_events(sender: SseSender): ResponseWriter -> void
  let event = make_sse_event("ready")
    .with(event: "status")
    .with(id: "1")
    .with(retry_millis: 2000)
  let _ = sender.send(event)
  let _ = sender.comment("keepalive")

get("/events") do:
  sse_response(publish_events)
```

`send` and `comment` return `Result<Unit, HostError>`. The response timeout is
an idle watchdog; periodic comments keep a quiet but healthy connection alive.
WebSockets are not currently part of the framework.

## Errors and rejections

Web distinguishes routing failures from request-decoding failures:

- an unknown path uses the not-found handler;
- a known path with the wrong method uses the method-not-allowed handler;
- invalid params, query, headers, cookies, bodies, or auth produce a
  `Rejection`;
- a timed-out route returns `504 Gateway Timeout`.

Customize these responses once at the application boundary:

```voyd
serve(port: 3000) routes():
  not_found() do(_ctx: Context):
    Response::not_found().text("Page not found")

  method_not_allowed() do(_ctx: Context):
    Response::method_not_allowed().text("Method not allowed")

  on_rejection() do(rejection: Rejection, _ctx: Context):
    Response::new(status: rejection.status).json(value: {
      error: rejection.message
    })
```

Returning `Result<T, Rejection>` uses the rejection's default status and text
response. To use the configured `on_rejection` handler, accept `Context` and
call `ctx.reject(error)`.

Common constructors are `bad_request`, `not_found`, `payload_too_large`,
`unsupported_media_type`, `unauthorized`, and `forbidden`.

## Authentication

The built-in policies read the `authorization` header:

```voyd
use std::optional::types::all

get("/account", auth: required_session()) do(session: String):
  json({ user: session })

get("/welcome", auth: optional_session()) do(session: Option<String>):
  match(session)
    Some<String> { value }:
      Response::ok().text("Welcome, ".concat(value))
    None:
      Response::ok().text("Welcome")
```

Production applications can provide an `AuthPolicy<T>` whose extractor
validates credentials and returns a typed session. Extractors may perform
effects, such as loading a session from a database. Return `unauthorized` for
missing or invalid credentials and `forbidden` when authenticated callers lack
permission.

## Middleware

Middleware receives `Context` and `Next`. Call `next(ctx)` to continue or
return early:

```voyd
use std::optional::types::all

fn require_request_id(ctx: Context, next: Next) -> Response
  match(ctx.header("x-request-id"))
    Some<String>:
      next(ctx)
    None:
      Response::bad_request().text("missing x-request-id")

serve(port: 3000) routes():
  adopt(require_request_id)

  get("/work") do:
    "accepted"
```

Middleware applies in declaration order. `adopt` affects routes declared after
it, including routes in later groups. The package includes
`request_id_required`, which implements the example above.

## OpenAPI

### What OpenAPI is for

OpenAPI is a machine-readable description of an HTTP API. An OpenAPI document
lists paths, methods, parameters, request bodies, response bodies, and their
schemas. Tools can use that JSON document to:

- render interactive API documentation with Swagger UI or Redoc;
- generate clients and server stubs;
- validate requests and responses in tests or gateways;
- import the API into tools such as Postman.

Web generates an OpenAPI 3.1 JSON document from explicit route metadata and
Voyd types. It can serve the raw document at `/openapi.json`. A documentation UI
is a separate frontend that reads that URL.

### Complete example

Every name used below is defined in the example. The real handler and its
OpenAPI description are created separately, then connected by
`document_openapi_route`.

```voyd
use pkg::web::all
use std::string::type::String

/// JSON accepted by POST /articles.
obj CreateArticleInput {
  /// Reader-visible article title.
  api title: String
}

/// JSON returned after an article is created.
obj Article {
  /// Stable article identifier.
  api id: i32,
  /// Reader-visible article title.
  api title: String
}

fn create_article(input: CreateArticleInput) -> Response
  let article = Article { id: 1, title: input.title }
  Response::created().json(value: article)

fn build_article_app() -> App
  let routes = post(
    app(),
    "/articles".as_slice(),
    body: json_body(),
    handler: create_article
  )

  let create_article_docs = openapi_operation(
    summary: "Create an article".to_string(),
    operation_id: "createArticle".to_string(),
    response_status: 201,
    response_description: "Article created".to_string()
  )
    .with_json_body<CreateArticleInput>()
    .responds_json<Article>()

  let empty_docs = openapi_document(openapi_info(
    title: "Articles API",
    version: "1.0.0"
  ))

  let docs = document_openapi_route(
    routes,
    empty_docs,
    create_article_docs
  )

  expose_openapi(routes, docs, at: "/openapi.json")
```

The resulting app has two endpoints:

- `POST /articles` runs `create_article`;
- `GET /openapi.json` returns the generated OpenAPI document.

`document_openapi_route(app, docs, operation)` reads the method and path of the
most recently added real route. This prevents the documentation from describing
a route that does not exist. When documenting several routes, add one route,
document it, and then repeat with the next route and the updated document.

### Describing request and response shapes

Start with `openapi_operation(...)`, then add the shapes used by the route:

| Method | Documents |
| --- | --- |
| `.with_path_params<T>()` | Fields captured from `:name` path segments |
| `.with_query<T>()` | Query-string fields |
| `.with_headers<T>()` | Request-header fields |
| `.with_json_body<T>()` | JSON request body |
| `.responds_json<T>()` | JSON response body |
| `.responds_sse<T>()` | SSE event payload |
| `.tagged(name)` | A grouping tag for documentation tools |

Type and field `///` comments become schema descriptions. Optional fields are
marked optional. Recursive record references are emitted under OpenAPI
components with deterministic identities.

## Static files

Mount a directory as middleware:

```voyd
serve(port: 3000) routes():
  get("/api/health") do:
    json({ healthy: true })

  adopt(serve_dir("./public"))
```

`serve_dir` handles `GET` and `HEAD`, blocks `..` traversal, serves
`index.html` for `/`, and continues to the next handler when a file is absent.
Declaration order controls precedence, so put API routes before static files
when API paths should win.

## Server-rendered VX

`html_response` renders `Html<Msg>` into an HTTP response:

```voyd
use std::vx::all

get("/") do:
  html_response(
    Response::ok(),
    <main>
      <h1>Voyd Journal</h1>
      <p>Rendered on the server.</p>
    </main>
  )
```

Use `render(view)` for an HTML fragment string and `document(view)` for a full
document beginning with `<!doctype html>`.

For an interactive page, `hydrate_named` embeds the initial model and client
entry alongside the server-rendered view:

```voyd
fn article_page(model: Model) -> Response
  html_response(
    Response::ok(),
    view: <html lang="en">
      <head><title>Voyd Journal</title></head>
      <body><div id="app">{view(model)}</div></body>
    </html>,
    hydrate: hydrate_named<Model>(
      id: "article-editor",
      target: "#app",
      entry: "/assets/client.js",
      model: model
    )
  )
```

The client must hydrate the same `view(model)` into the selected container.
The `web-ssr` starter includes the complete browser bridge and build wiring.
Use `append_hydration` for additional interactive roots in one document.

## Timeouts and server limits

Apply a timeout to slow route work:

```voyd
get("/reports/daily", timeout: timeout_millis(2000)) do:
  json({ ready: true })
```

Protect the whole process with server options:

```voyd
serve(
  port: 3000,
  host: "0.0.0.0",
  shutdown_timeout: 30000,
  max_body_bytes: 1024 * 1024,
  max_pending_requests: 128
) routes():
  get("/health") do:
    "ok"
```

- `max_body_bytes` caps request bodies before route handling;
- `max_pending_requests` limits queued detached request tasks;
- `shutdown_timeout` controls how long the host waits for active handlers.

Use smaller route-specific body limits whenever practical.

## Streaming request bodies

Ordinary routes buffer bodies. Use `serve_streaming(app, port: ...)` when an
upload should be consumed incrementally. Mark that route with `.streaming()`,
then retrieve its one-shot reader from `ctx.streaming_body()`.

Request reads are backpressure-aware and capped at 16 KiB per chunk. Successful
reads refresh the response idle watchdog. JSON, text, and multipart extractors
continue to work on other routes in the same app.

## Composing applications

Use the route DSL for normal applications. Use the `App` method API when routes
are assembled conditionally or need to be passed to another function:

```voyd
let web_app = app()
  .get("/health", handler: () => "ok")
  .get_context(
    "/debug",
    handler: (ctx) => json({ path: ctx.path() })
  )
```

Mount a reusable router under a prefix:

```voyd
use pkg::web::router

let api = router::Router::init()
  .get("/health", handler: () => "ok")

let web_app = app().mount("/api", api)
```

Serve an `App` with `serve(web_app, port: 3000)` or
`serve_app(web_app, port: 3000)`. `build_app` and the free builder helpers are
available for advanced callback-based composition.

## Testing

Build an `App` without opening a socket, then call `handle` with an
`IncomingRequest`:

```voyd
use pkg::web::all
use std::http::{ Body, Headers, IncomingRequest, Method }
use std::optional::types::all
use std::test::assertions::all

fn test_app() -> App
  app().get("/health", handler: () => "ok")

fn health_request() -> IncomingRequest
  IncomingRequest {
    method: Method::Get {},
    path: "/health".to_string(),
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

test "health route succeeds":
  let response = test_app().handle(health_request())
  assert(response.status.code(), eq: 200)
```

Run project tests with:

```bash
npx voyd test ./src
```

Use host-level integration tests only for behavior that needs network adapters,
filesystem-backed static files, shutdown, or the combined SSR and hydration
flow.

## Production checklist

Before deploying:

- bind to the host and port supplied by the environment;
- set global and route-specific body limits;
- add timeouts around slow external work;
- validate authentication server-side;
- return generic client errors while logging actionable server details;
- serve immutable assets with cache-friendly names and HTTPS;
- retain graceful `SIGINT` and `SIGTERM` handling;
- monitor rejection rates, handler failures, latency, and pending requests.

For tighter imports, the public modules are `router`, `routes`, `extract`,
`response`, `html`, `middleware`, `static_files`, `streaming`, `sse`,
`multipart`, `negotiate`, and `openapi`.
