---
order: 9
---

# Web

`pkg::web` is Voyd's HTTP application framework. It provides routing,
middleware, typed request data, response conversion, static files, and
server-rendered VX pages.

Use it for JSON APIs, server-rendered sites, or applications that combine an
HTTP server with an interactive VX client.

## Start A Web Project

Install the Voyd CLI and scaffold the Web starter:

```bash
npm install -g @voyd-lang/cli
voyd bootstrap my-site --template web-ssr
cd my-site
npm install
npm run dev
```

This is the recommended starting point for both APIs and server-rendered sites
because it includes the Node host and development workflow. For an API, keep
`src/main.voyd` and remove the client and hydration code you do not need. For an
interactive site, use the complete starter.

The generated project includes the Web package, VX server rendering and
hydration, Vite, Tailwind CSS, and static assets. Its main files are:

- `src/main.voyd`: the HTTP server, routes, server data, and rendered pages.
- `src/client.voyd`: the VX application that runs after hydration.
- `src/client.ts`: loads the client Wasm module and hydrates the page.
- `public/`: files served directly by the application.
- `scripts/dev.mjs`: rebuilds the client and restarts the server in development.
- `scripts/serve.mjs`: compiles and runs the server.

Useful commands are:

```bash
npm run dev          # rebuild and restart while editing
npm run voyd:check   # compile-check the Voyd server and client
npm run build        # build production client assets and check Voyd
npm start            # run the server
```

The generated host reads `PORT` or `VOYD_WEB_PORT` and `HOST` or
`VOYD_WEB_HOST`. Production platforms usually require binding all interfaces:

```bash
npm run build
HOST=0.0.0.0 PORT=8080 npm start
```

## A Minimal Server

Replace the generated `src/main.voyd` with a small server while learning the
framework:

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
      Response::ok().text("ok")
```

`serve` uses `std::http::server`, so the entrypoint lists the server and task
runtime effects. Any effects used by your handlers also remain visible in the
entrypoint's effect row.

Most applications should import `pkg::web::all`. For tighter imports, the public
modules are `router`, `routes`, `extract`, `response`, `html`, `middleware`, and
`static_files`.

## Routes

Use `get`, `post`, `put`, `patch`, and `delete` for common methods. Use `route`
when the method is dynamic or less common:

```voyd
use pkg::web::all
use std::http::Method

serve(port: 3000) routes():
  get("/articles") do:
    list_articles()

  post("/articles") do(ctx: Context):
    create_article(ctx)

  route("/events", method: Method::Delete {}) do:
    Response::ok().text("deleted")
```

Path segments beginning with `:` are parameters:

```voyd
use std::string::type::String

type ArticleParams = {
  slug: String
}

serve(port: 3000) routes():
  get("/articles/:slug") do(params: ArticleParams):
    find_article(params.slug)
```

Static routes take precedence over parameter routes, so `/articles/new` wins
over `/articles/:slug` regardless of registration order.

Group routes under a shared prefix:

```voyd
serve(port: 3000) routes():
  group("/api") routes():
    get("/health") do:
      "ok"

    group("/articles") routes():
      get("/:slug") do(params: ArticleParams):
        find_article(params.slug)
```

Trailing slashes are strict by default. To treat `/about` and `/about/` as the
same path, configure an app with `ignore_trailing_slash()`:

```voyd
let web_app = app()
  .with(trailing_slash: ignore_trailing_slash())
  .get("/about", handler: () -> String => "About")
```

## Handler Results

Handlers return values; they do not write to a mutable response object. Web
converts supported values through `IntoResponse`:

```voyd
get("/text") do:
  "hello"

get("/created") do:
  (Status::created(), "created")

get("/custom") do:
  Response::created()
    .with(headers: Headers::empty().append(
      header: "location",
      value: "/articles/first"
    ))
    .text("created")
```

Supported result shapes include:

- `Response`, returned unchanged.
- `String` and `StringSlice`, returned as `200 OK` text.
- `Bytes`, returned as `200 OK` bytes.
- `JsonValue`, returned as `200 OK` JSON.
- `(Status, String)`, `(Status, StringSlice)`, `(Status, Bytes)`, and
  `(Status, JsonValue)`.
- `Result<T, E>` when both branches can become a response.
- `Option<T>`, where `None` becomes `404 Not Found`.

Return a typed DTO as JSON with `json_dto`:

```voyd
type ArticleSummary = {
  slug: String,
  title: String
}

get("/api/articles/:slug") do(params: ArticleParams):
  json_dto<ArticleSummary>({
    slug: params.slug,
    title: "A Voyd article"
  })
```

Use `response_dto_json(Response::created(), value:)` to choose the status,
`result_dto_json` for a `Result`, and `option_dto_json` when absence should be a
404. Use `response_json(value)` for an existing `JsonValue`; the root-level
`json()` name is reserved for the JSON request-body policy.

## Typed Request Data

The route DSL chooses extractors from handler parameter names:

- `params: T` decodes path parameters.
- `query: T` decodes query parameters.
- `headers: T` decodes request headers.
- `cookies: T` decodes cookies.
- `ctx: Context` provides the complete request context.

Extractor parameters must use a supported order. You can request `params`,
`headers`, or `cookies` alone; `params` plus `query`; `params` plus `headers`;
`query` plus `headers`; or `params`, `query`, and `headers`. Any of these shapes
can add a final `ctx`. A query-only handler must include that final context:

```voyd
type SearchFilter = {
  exact: bool
}

get("/search") do(query: SearchFilter, ctx: Context):
  ctx
  if query.exact then: "exact" else: "fuzzy"
```

For another combination, accept `ctx` and read the value dynamically, or use an
explicit builder helper from [Composing Applications](#composing-applications).

Use structural records for request-shaped data. Start with the common case of
path and query parameters:

```voyd
type SearchParams = {
  organization: String
}

type SearchQuery = {
  q: String,
  page: i32,
  exact: bool
}

serve(port: 3000) routes():
  get("/orgs/:organization/search") do(
    params: SearchParams,
    query: SearchQuery
  ):
    Response::ok().text(
      params.organization
        .concat(":")
        .concat(query.q)
    )
```

Ask for typed headers or cookies only on routes that need them:

```voyd
type RequestHeaders = {
  authorization: String
}

get("/account") do(headers: RequestHeaders):
  Response::ok().text(headers.authorization)
```

```voyd
type SessionCookies = {
  session: String
}

get("/session") do(cookies: SessionCookies):
  Response::ok().text(cookies.session)
```

Path parameters, headers, and cookies decode as strings. Query values decode
`true` and `false` as booleans, canonical integer strings as integers, and other
values as strings. Missing required fields or incompatible field types produce a
`400 Bad Request`. Make a field optional when the request may omit it.

### Request Context

Use `Context` when you need dynamic access or the raw request:

```voyd
get("/inspect/:id") do(ctx: Context):
  let id = ctx.param("id") ?? "missing"
  let mode = ctx.query_value("mode") ?? "default"
  let session = ctx.cookie("session") ?? "anonymous"
  Response::ok().text(id.concat(":").concat(mode).concat(":").concat(session))
```

The most useful methods are:

- `method()` and `path()`.
- `header(name)`, `param(name)`, `query_value(name)`, and `cookie(name)`.
- `query()` and `cookies()` for all parsed values.
- `body_bytes()`, `text()`, and `json()` for direct body access.
- `reject(rejection)` to send a value through the current rejection handler.

Prefer typed parameters when the request shape is fixed. Use `Context` for
dynamic data or framework-level code.

## Request Bodies

Declare a body policy on the route:

```voyd
use std::bytes::Bytes

type CreateArticle = {
  title: String,
  published: bool
}

serve(port: 3000) routes():
  post("/api/articles", body: json_body()) do(input: CreateArticle):
    response_dto_json(
      Response::created(),
      value: { title: input.title, published: input.published }
    )

  post("/echo", body: text_body()) do(input: String):
    Response::ok().text(input)

  put("/upload", body: bytes()) do(input: Bytes):
    Response::ok().bytes(input)
```

`json_body()` accepts `application/json` and media types ending in `+json`.
Invalid JSON or text produces `400 Bad Request`; an unsupported JSON content
type produces `415 Unsupported Media Type`.

Limit a route body independently of the server-wide limit:

```voyd
post(
  "/api/articles",
  body: json_body(),
  limit: body_limit(64 * 1024)
) do(input: CreateArticle):
  json_dto<CreateArticle>(input)
```

The `json()` and `text()` aliases also create body policies. The longer names
are usually clearer in a route declaration.

### HTML Forms

A normal `POST` form sends an `application/x-www-form-urlencoded` body. Read it
as text and use `parse_query` to decode field names, percent escapes, and `+`
spaces:

```voyd
use std::msgpack::MsgPack
use std::optional::types::all
use std::string::type::String
use std::vx::all

fn NewArticleForm() -> Html<MsgPack>
  <form method="post" action="/articles">
    <label for="title">Title</label>
    <input id="title" name="title" required />
    <button type="submit">Create article</button>
  </form>

post("/articles", body: text_body()) do(input: String):
  match(parse_query(input).get("title"))
    Some<String> { value }:
      Response::created().text(value)
    None:
      Response::bad_request().text("title is required")
```

For a form with `method="get"`, use the normal typed `query: T` extractor.
Validate required fields and application rules in the handler even when the HTML
form also uses browser validation.

## Authentication

The built-in session policies read the `authorization` header:

```voyd
use std::optional::types::all

serve(port: 3000) routes():
  get("/account", auth: required_session()) do(session: String):
    Response::ok().text(session)

  get("/welcome", auth: optional_session()) do(session: Option<String>):
    match(session)
      Some<String> { value }:
        Response::ok().text("Welcome, ".concat(value))
      None:
        Response::ok().text("Welcome")
```

For a real application, create an `AuthPolicy<T>` that validates a token or
loads a typed session:

```voyd
use std::http::IncomingRequest
use std::result::types::all

obj Session {
  api user_id: String,
  api role: String
}

fn authenticate(request: IncomingRequest) -> Result<Session, Rejection>
  match(request.header("authorization"))
    Some<String> { value }:
      lookup_session(value)
    None:
      Err<Rejection> {
        error: Rejection::unauthorized("missing authorization")
      }

serve(port: 3000) routes():
  get(
    "/account",
    auth: required_session<Session>(extract: authenticate)
  ) do(session: Session):
    Response::ok().text(session.user_id)
```

An auth extractor can perform effects, so it may call a database or another
service. Return `Rejection::unauthorized` for missing or invalid credentials and
`Rejection::forbidden` when the caller is authenticated but lacks permission.

## Middleware

Middleware receives `Context` and `Next`. Call `next(ctx)` to continue, or
return a response early:

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

Middleware is applied in registration order. An `adopt` affects routes declared
after it, including routes inside later groups. Middleware adopted inside a
group stays in that group.

The package includes `request_id_required`, which rejects requests without an
`x-request-id` header.

## Errors And Rejections

Web distinguishes route failures from request-data failures:

- An unknown path uses the not-found handler.
- A known path with the wrong method uses the method-not-allowed handler.
- Invalid params, query, headers, cookies, bodies, or auth produce `Rejection`.
- A timed-out route returns `504 Gateway Timeout`.

Customize those responses at the application boundary:

```voyd
serve(port: 3000) routes():
  not_found() do(_ctx: Context):
    Response::not_found().text("Page not found")

  method_not_allowed() do(_ctx: Context):
    Response::method_not_allowed().text("Method not allowed")

  on_rejection() do(rejection: Rejection, _ctx: Context):
    response_dto_json(
      Response::new(status: rejection.status),
      value: { error: rejection.message }
    )
```

Returning `Result<T, Rejection>` directly converts the rejection to its default
status and text response. To pass application validation through a customized
`on_rejection` handler, accept `Context` and call `ctx.reject(error)`:

```voyd
fn validate(input: CreateArticle) -> Result<CreateArticle, Rejection>
  if input.title.is_empty() then:
    Err<Rejection> {
      error: Rejection::bad_request("title is required")
    }
  else:
    Ok<CreateArticle> { value: input }

post("/articles", body: json_body()) do(input: CreateArticle, ctx: Context):
  match(validate(input))
    Ok<CreateArticle> { value }:
      response_dto_json(Response::created(), value: value)
    Err<Rejection> { error }:
      ctx.reject(error)
```

Available rejection constructors include `bad_request`, `not_found`,
`payload_too_large`, `unsupported_media_type`, `unauthorized`, and `forbidden`.

## Timeouts And Server Limits

Set a route timeout for handlers that perform external work:

```voyd
get("/reports/daily", timeout: timeout_millis(2000)) do:
  build_daily_report()
```

You can combine `timeout:`, `body:`, `limit:`, and `auth:` on the same route.

Server options protect the entire process:

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

- `max_body_bytes` caps request bodies before route handling.
- `max_pending_requests` limits queued detached request tasks.
- `shutdown_timeout` sets how many milliseconds the host waits for a request
  handler to produce a response. A host timeout becomes a `500` response.

Choose limits for the largest legitimate request your application accepts, then
use smaller route body limits where possible.

## Static Files

Mount a directory as middleware:

```voyd
serve(port: 3000) routes():
  get("/api/health") do:
    "ok"

  adopt(serve_dir("./public"))
```

`serve_dir` handles `GET` and `HEAD`, blocks `..` traversal, serves `index.html`
for `/`, and calls the next handler when a file is absent. It recognizes common
HTML, CSS, JavaScript, JSON, PNG, JPEG, and SVG content types; other files use
`application/octet-stream`.

Registration order determines precedence. Put API routes before static
middleware when API paths should win. Put a final parameterized page route after
static middleware so existing assets win over the fallback.

## Server-Rendered VX

`pkg::web::html` converts `Html<Msg>` into an HTML response:

```voyd
use std::vx::all

fn home() -> Response
  html_response(
    Response::ok(),
    <main>
      <h1>Voyd Journal</h1>
      <p>Rendered on the server.</p>
    </main>
  )
```

Use `render(view)` when you need an HTML fragment as a string. Use
`document(view)` for a full string beginning with `<!doctype html>`.

### Hydrate An Interactive Page

Render the initial model, target selector, and client entry together:

```voyd
fn article_page(model: Model) -> Response
  html_response(
    Response::ok(),
    view: <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Voyd Journal</title>
        <link rel="stylesheet" href="/assets/client.css" />
      </head>
      <body>
        <div id="app">{view(model)}</div>
      </body>
    </html>,
    hydrate: hydrate(
      target: "#app",
      entry: "/assets/client.js",
      model: model
    )
  )
```

The helper safely serializes the model into an `application/json` script and
adds the module entry. The hydration model must be boundary-safe and must match
the model expected by the client VX app.

In the client entry, read that model and hydrate instead of mounting a new tree:

```ts
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, hydrateVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/client.wasm?url";

const data = document.querySelector<HTMLScriptElement>("[data-voyd-hydration]");
const selector = data?.dataset.voydHydration;
const container = selector ? document.querySelector(selector) : null;

if (!data || !container) throw new Error("Missing hydration data");

const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const host = await createVoydHost({
  wasm,
  bufferSize: 1024 * 1024,
  defaultAdapters: { runtime: "browser" },
});
const app = createVoydVxAppRuntime({
  host,
  initialModel: JSON.parse(data.textContent ?? "null"),
});
const mounted = await hydrateVxApp({ container, app });
```

The server view and client `view` must produce the same initial tree. Browser
commands and subscriptions begin after hydration. The `web-ssr` starter contains
the complete build and host wiring, so it is the best starting point for this
architecture.

## Composing Applications

Choose the smallest composition API that fits:

- Use the route DSL shown throughout this guide for normal application routes.
- Use `App` methods when routes are generated or assembled conditionally.
- Use `Router` for a reusable group that will be mounted under a prefix.
- Use free builder helpers only when a callback must thread an `AppBuild` value.

The `App` method API is also convenient in direct handler tests:

```voyd
fn health() -> String
  "ok"

let web_app = app()
  .get("/health", handler: health)
  .get("/debug", handler: (ctx: Context) -> Response =>
    Response::ok().text(ctx.path())
  )
```

Explicit method names make extracted handler shapes clear:

```voyd
let api = app()
  .get_params(
    "/articles/:slug",
    handler: (params: ArticleParams) -> Response =>
      Response::ok().text(params.slug)
  )
  .get_params_query(
    "/articles/:slug/revisions",
    handler: (params: ArticleParams, query: SearchQuery) -> Response =>
      revisions(params.slug, query.page)
  )
```

For a reusable subrouter, create `router::Router` and mount it:

```voyd
use pkg::web::router

let api = router::Router::init()
  .get("/health", handler: () -> String => "ok")

let web_app = app().mount("/api", api)
```

For advanced callback-based composition, `build_app` threads an `AppBuild`
through free helpers:

```voyd
let web_app = build_app do(base):
  let with_health = get_context(base, "/health") do(_ctx: Context):
    "ok"

  post(
    with_health,
    "/echo",
    body: text_body(),
    handler: (input: String) -> Response => Response::ok().text(input)
  )
```

Serve an existing `App` with `serve(web_app, port: 3000)` or
`serve_app(web_app, port: 3000)`. Use `serve_build` when you want builder-style
composition and server options in one call.

## Testing A Web App

Build an `App` without opening a socket, then call `app.handle(request)` with an
`IncomingRequest`. This is the fastest way to test routing, extraction,
middleware, authentication policies, and response conversion.

```voyd
use pkg::web::all
use std::http::{ Body, Headers, IncomingRequest, Method }
use std::optional::types::all
use std::string::type::String
use std::test::assertions::all

fn test_app() -> App
  app().get("/health", handler: () -> String => "ok")

fn request(path: String) -> IncomingRequest
  IncomingRequest {
    method: Method::Get {},
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

test "health route succeeds":
  let response = test_app().handle(request("/health"))
  assert(response.status.code(), eq: 200)
```

Run project tests with:

```bash
npx voyd test ./src
```

Add integration tests around the running host for behavior that depends on
network adapters, filesystem-backed static files, shutdown, or the combined SSR
and hydration flow. Keep application validation and data transformation in
ordinary functions so they can be tested directly.

## Production Checklist

Before deploying:

- Bind to the host and port provided by your environment.
- Set global and route-specific body limits.
- Add timeouts around slow external work.
- Validate authentication server-side; never trust hydrated client state for
  authorization.
- Return generic client errors while logging actionable server details.
- Serve immutable assets with cache-friendly names and HTTPS.
- Keep the generated `SIGINT` and `SIGTERM` handling, and design request work to
  tolerate interruption during shutdown.
- Monitor rejection rates, handler failures, latency, and pending requests.
