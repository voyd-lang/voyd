# Std HTTP and Host Server Support

Status: Proposed
Owner: Std + Runtime + SDK
Scope: `packages/std/src/http*`, `packages/js-host`, optional SDK/server helper package

## Summary

Voyd should have a small, canonical HTTP foundation in `std`, a host-backed
client effect for outbound requests, and a host-backed server effect for inbound
requests.

The library's job is to define the portable protocol values and host capability
contracts that every higher-level library can share:

- `std::http`: pure HTTP values and helpers
- `std::http::client`: outbound HTTP client capability
- `std::http::server`: inbound server capability

This proposal should remove `std::fetch`. There is no need to preserve backward
compatibility yet, and keeping both `std::fetch` and `std::http::client` would
leave two names for the same capability before the API has stabilized.

## Goals

- Provide one canonical HTTP value model for std, clients, servers, and web
  frameworks.
- Replace `std::fetch` with `std::http::client`.
- Make common code read naturally in Voyd: labeled parameters, overloads,
  `Result`/`Option`, nominal types for values with invariants, and structural
  records where shape compatibility is the point.
- Keep host capabilities explicit through effects.
- Keep request and response bodies fully buffered for the MVP.
- Normalize Node, Deno, Bun, browser, and custom host differences inside the JS
  host adapter layer.

## Non-Goals

- No routing, middleware, sessions, auth, or static-file policy in `std::http`.
- No streaming body API in the MVP.
- No runtime-specific Voyd APIs.
- No dependency from `std::http` to `std::vx`.
- No `std::fetch` compatibility shim.

## Design Principles

### Protocol Values Are Shared

HTTP values such as methods, statuses, headers, and bodies should have one home.
`std::http::client`, `std::http::server`, and `packages/web` should all depend
on that home instead of duplicating small incompatible models.

### Client And Server Requests Are Different

Do not force inbound server requests and outbound client requests into one
struct. They share method, headers, and body, but their targets differ:

- clients send an absolute URL
- servers receive an origin-form path/query target

The shared model should make that distinction explicit.

### Nominal Types Should Guard Invariants

Use nominal types for values with behavior or invariants:

- `Headers`
- `HeaderName`
- `Status`
- `Body`
- `Server`
- `RequestHandle`

Use structural records for simple configuration and user data:

- `ServerConfig`
- DTO-compatible route params/query/body values in higher layers

### Effects Model Capabilities

Outbound HTTP and inbound serving are host capabilities, not ambient runtime
objects. Voyd code should show that it needs outbound HTTP by declaring
`HttpClient` in its effect row and inbound server access by declaring
`HttpServer`.

### Semantic Modifiers Use Labels

Immutable value modifiers should prefer overloaded semantic names with labels
over type-encoded names. For example, use `request.with(header: ..., value: ...)`
and `response.with(status: ...)` instead of `with_header` or `with_status`.

Keep distinct verbs when the verb is the behavior. `Headers::append` and
`Headers::set` should remain separate because repeated headers make append vs
replace semantically meaningful.

### Wire Format Is An Implementation Detail

Internal std helpers may encode/decode host payloads, but the public API should
talk in terms of `IncomingRequest`, `client::ClientRequest`, `Response`,
`Body`, and `Result`.

If a low-level escape hatch is needed, put it in an explicitly named internal or
advanced module such as `std::http::wire`.

## Layering

Recommended module split:

1. `std::http`
   Pure values and helpers.
2. `std::http::client`
   Host-backed outbound HTTP client effect and request helpers.
3. `std::http::server`
   Host-backed inbound server effect and safe request lifecycle helpers.
4. `packages/web`
   Router, middleware, extractors, policies, response conversion, static files.

This keeps the standard library stable and narrow while allowing the framework
to evolve quickly.

## `std::http`

`std::http` should be pure. It should not listen on sockets or call host effects.

Recommended public contents:

- `Method`
- `Status`
- `Header`
- `HeaderName`
- `Headers`
- `Body`
- `IncomingRequest`
- `Response`
- `RequestTarget`
- `QueryString`
- `HttpError`

Cookies can come later. They are important, but they should be designed as
their own focused layer once headers and response builders are settled.

### Methods

HTTP methods are mostly a closed vocabulary with an extension point. Model that
directly.

```voyd
pub enum Method
  Get
  Head
  Post
  Put
  Patch
  Delete
  Options
  Trace
  Connect
  Other { value: String }
```

Recommended helpers:

- `Method::from(value: StringSlice) -> Method`
- `Method::as_string(self) -> String`
- `method(value: StringSlice) -> Method`

Provide `String` and `StringSlice` overloads for public string-taking helpers.

### Status

Status codes have a constrained valid range and common constructors. A nominal
type is the right fit.

```voyd
pub obj Status {
  pri code_value: i32,
  pri reason_value: String
}

impl Status
  api fn from(code: i32) -> Result<Status, HttpError>
  api fn custom({ code: i32, reason: String }) -> Result<Status, HttpError>
  api fn code(self) -> i32
  api fn reason(self) -> String
  api fn is_success(self) -> bool
  api fn is_client_error(self) -> bool
  api fn is_server_error(self) -> bool

  api fn ok() -> Status
  api fn created() -> Status
  api fn no_content() -> Status
  api fn bad_request() -> Status
  api fn unauthorized() -> Status
  api fn forbidden() -> Status
  api fn not_found() -> Status
  api fn method_not_allowed() -> Status
  api fn internal_server_error() -> Status
```

The constructor should reject codes outside `100..599`. Common constructors can
avoid returning `Result` because their values are known valid.

### Headers

Headers need behavior: case-insensitive lookup, repeated values, append vs set,
and future `Set-Cookie` support. Use a nominal collection rather than exposing
`Array<Header>` as the primary type.

```voyd
pub obj HeaderName {
  pri original: String,
  pri normalized: String
}

pub type Header = {
  name: HeaderName,
  value: String
}

pub obj Headers {
  pri entries: Array<Header>
}
```

Recommended methods:

- `HeaderName::from(value: StringSlice) -> Result<HeaderName, HttpError>`
- `HeaderName::as_string(self) -> String`
- `HeaderName::normalized(self) -> String`
- `Headers::empty() -> Headers`
- `Headers::from(entries: Array<Header>) -> Result<Headers, HttpError>`
- `headers() -> Headers`
- `Headers::append(self, { header: Header }) -> Headers`
- `Headers::append(self, { header name: StringSlice, value: StringSlice }) -> Headers`
- `Headers::append(self, { header name: String, value: String }) -> Headers`
- `Headers::set(self, { header: Header }) -> Headers`
- `Headers::set(self, { header name: StringSlice, value: StringSlice }) -> Headers`
- `Headers::set(self, { header name: String, value: String }) -> Headers`
- `Headers::remove(self, name) -> Headers`
- `Headers::get(self, name) -> Option<String>`
- `Headers::get_all(self, name) -> Array<String>`
- `Headers::contains(self, name) -> bool`
- `Headers::entries(self) -> Array<Header>`
- `Headers::content_type(self) -> Option<String>`
- `Headers::content_length(self) -> Option<i64>`

Header mutation methods should return new `Headers` values. If a mutating
variant is later useful for performance, it can be an explicit `~self` method.

### Body

The MVP should buffer bodies fully. The type should still avoid text-only
assumptions.

```voyd
pub enum Body
  Empty
  Bytes { value: Bytes }
  Text { value: String }
```

Recommended helpers:

- `Body::empty() -> Body`
- `Body::bytes(value: Bytes) -> Body`
- `Body::text(value: StringSlice) -> Body`
- `Body::len(self) -> i32`
- `Body::is_empty(self) -> bool`
- `Body::as_bytes(self) -> Bytes`
- `Body::as_text(self) -> Result<String, HttpError>`

JSON is a response/content concern layered on top of bytes or text. For the MVP,
`std::http` can provide `Response::json(value: JsonValue)`. Generic DTO-to-JSON
support should use a proper JSON encoding trait or compiler-supported DTO
serialization when that exists; it should not expose MessagePack as the user API.

### Request Targets

Keep client and server request targets distinct.

```voyd
pub obj QueryString {
  api raw: String
}

pub enum RequestTarget
  Origin { path: String, query?: QueryString }
  Absolute { url: String }
```

`IncomingRequest` should use `RequestTarget::Origin`. `client::ClientRequest`
can use `RequestTarget::Absolute`, or simply keep a dedicated `url` field for
clarity.

### Incoming Requests

Inbound server requests should be shaped for server code.

```voyd
pub obj IncomingRequest {
  api method: Method,
  api path: String,
  api query?: QueryString,
  api headers: Headers,
  api body: Body
}
```

Recommended helpers:

- `IncomingRequest::header(self, name) -> Option<String>`
- `IncomingRequest::query_string(self) -> Option<String>`
- `IncomingRequest::body_bytes(self) -> Bytes`
- `IncomingRequest::text(self) -> Result<String, HttpError>`
- `IncomingRequest::json(self) -> Result<JsonValue, HttpError>`

Parsed query maps should probably live in `packages/web`, where typed extractors
can turn query strings into structural DTOs.

### Client Requests Belong To `std::http::client`

Outbound requests need absolute URLs and client-specific policy. Those types
should live in `std::http::client`, not in the pure root module. The root module
should still own the shared values those requests use: `Method`, `Headers`,
`Body`, `Status`, and `Response`.

### Responses

`Response` should be canonical across std, `std::http::client`,
`std::http::server`, and the web framework.

```voyd
pub obj Response {
  api status: Status,
  api headers: Headers,
  api body: Body
}
```

Recommended methods:

- `Response::new({ status, headers?, body? }) -> Response`
- `Response::ok() -> Response`
- `Response::created() -> Response`
- `Response::no_content() -> Response`
- `Response::bad_request() -> Response`
- `Response::unauthorized() -> Response`
- `Response::forbidden() -> Response`
- `Response::not_found() -> Response`
- `Response::method_not_allowed() -> Response`
- `Response::internal_server_error() -> Response`
- `Response::with(self, { status: Status }) -> Response`
- `Response::with(self, { header: Header }) -> Response`
- `Response::with(self, { header name: StringSlice, value: StringSlice }) -> Response`
- `Response::with(self, { header name: String, value: String }) -> Response`
- `Response::with(self, { headers: Headers }) -> Response`
- `Response::with(self, { body: Body }) -> Response`
- `Response::text(self, value: StringSlice) -> Response`
- `Response::bytes(self, value: Bytes) -> Response`
- `Response::json(self, value: JsonValue) -> Response`
- `Response::empty(self) -> Response`

`Response::text`, `Response::bytes`, and `Response::json` should set a sensible
`content-type` unless one is already present.

The higher-level framework can re-export this type and add `IntoResponse`
implementations. It should not define a competing response model.

## `std::http::client`

`std::http::client` should replace `std::fetch` as the outbound HTTP API.

The name is intentionally protocol-level rather than JavaScript-specific:

- `client` pairs cleanly with `server`
- the same API can work in Node, Deno, Bun, browsers, and custom hosts
- the module can grow into redirects, timeouts, and body policy without carrying
  browser `fetch` naming assumptions

### Removal Of `std::fetch`

This proposal requires removing `std::fetch`.

Required work:

- delete `packages/std/src/fetch.voyd`
- remove `std::fetch` from `packages/std/src/pkg.voyd`
- remove any prelude/package-root exports for `fetch`
- remove `voyd.std.fetch` host capability registration
- remove or rewrite existing `fetch` tests against `std::http::client`
- update smoke fixtures and docs to import `std::http::client`

No compatibility facade should be added. The API is still young enough that a
clean break is better than carrying a duplicate name.

### Effect

Recommended effect id:

```voyd
@effect(id: "voyd.std.http.client")
```

Raw effect operation:

```voyd
pub eff HttpClient
  request(tail, payload: MsgPack) -> MsgPack
```

As with server support, raw `MsgPack` payloads are std implementation details.
Application code should call the typed helpers below.

### Public Types

```voyd
pub obj ClientRequest {
  api method: http::Method,
  api url: String,
  api headers: http::Headers,
  api body: http::Body,
  api options: RequestOptions
}

pub obj RequestOptions {
  api timeout_millis?: i32,
  api redirect_policy: RedirectPolicy
}

pub enum RedirectPolicy
  Follow { max_redirects: i32 }
  Manual
  Error
```

`ClientRequest` should be nominal because it carries policy and should have
constructor defaults. `RequestOptions` can be nominal as well because redirect
and timeout behavior will grow over time.

Default request options:

- no timeout unless explicitly set
- redirect policy: `Follow { max_redirects: 20 }`
- empty body
- empty headers
- method defaults only through named constructors, not through a vague
  all-purpose initializer

### Request Builders

Recommended constructors:

```voyd
impl ClientRequest
  api fn get(url: StringSlice) -> ClientRequest
  api fn head(url: StringSlice) -> ClientRequest
  api fn delete(url: StringSlice) -> ClientRequest
  api fn post({ url: StringSlice, body: http::Body }) -> ClientRequest
  api fn put({ url: StringSlice, body: http::Body }) -> ClientRequest
  api fn patch({ url: StringSlice, body: http::Body }) -> ClientRequest

  api fn custom({
    method: http::Method,
    url: StringSlice,
    body?: http::Body,
    headers?: http::Headers,
    options?: RequestOptions
  }) -> ClientRequest
```

Provide `String` overloads for every public `StringSlice`-taking constructor.

The common methods should be easy:

```voyd
let request = ClientRequest::post(
  url: "https://api.example.com/users",
  body: http::Body::text(payload)
)
```

The custom path should remain explicit:

```voyd
let request = ClientRequest::custom(
  method: http::Method::Other { value: "PROPFIND" },
  url: "https://example.com/files",
  headers: http::headers().append(header: "depth", value: "1")
)
```

### Immutable Modifiers

Recommended modifiers:

```voyd
impl ClientRequest
  api fn with(self, { header: http::Header }) -> ClientRequest
  api fn with(self, { header name: StringSlice, value: StringSlice }) -> ClientRequest
  api fn with(self, { header name: String, value: String }) -> ClientRequest
  api fn with(self, { headers: http::Headers }) -> ClientRequest
  api fn with(self, { body: http::Body }) -> ClientRequest
  api fn with(self, { timeout_millis: i32 }) -> ClientRequest
  api fn with(self, { redirect_policy: RedirectPolicy }) -> ClientRequest
```

These should return new request values. If mutating variants are later useful,
make them explicit `~self` APIs.

### Send Functions

Recommended module functions:

```voyd
pub fn send(request: ClientRequest): HttpClient -> Result<http::Response, HostError>

pub fn request(request: ClientRequest): HttpClient -> Result<http::Response, HostError>

pub fn get(url: StringSlice): HttpClient -> Result<http::Response, HostError>

pub fn head(url: StringSlice): HttpClient -> Result<http::Response, HostError>

pub fn delete(url: StringSlice): HttpClient -> Result<http::Response, HostError>

pub fn post({
  url: StringSlice,
  body: http::Body
}): HttpClient -> Result<http::Response, HostError>

pub fn put({
  url: StringSlice,
  body: http::Body
}): HttpClient -> Result<http::Response, HostError>

pub fn patch({
  url: StringSlice,
  body: http::Body
}): HttpClient -> Result<http::Response, HostError>
```

`send` is the clearest name for prebuilt requests. `request` can exist as an
alias if that reads better in protocol-heavy code, but docs should prefer
`send`.

Provide `String` overloads for every public URL-taking module function.

Example:

```voyd
use std::http
use std::http::client

fn load_user(id: String): client::HttpClient -> Result<http::Response, HostError>
  client::get("https://api.example.com/users/".concat(id))
```

More deliberate request construction:

```voyd
fn create_user(payload: String): client::HttpClient -> Result<http::Response, HostError>
  let request = client::ClientRequest::post(
    url: "https://api.example.com/users",
    body: http::Body::text(payload)
  )
    .with(header: "content-type", value: "application/json")
    .with(timeout_millis: 5000)

  client::send(request)
```

### Response Helpers

Response body helpers should live on `http::Response` or in `std::http`, not in
the client module. A response from `std::http::server` and a response from
`std::http::client` are the same protocol value.

Recommended helpers:

- `Response::is_success(self) -> bool`
- `Response::header(self, name) -> Option<String>`
- `Response::text(self) -> Result<String, HttpError>`
- `Response::bytes(self) -> Bytes`
- `Response::json(self) -> Result<JsonValue, HttpError>`

### Host DTO Shape

The host adapter can normalize outbound requests internally as:

```ts
type DefaultAdapterHttpClientRequest = {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
  timeoutMillis?: number;
  redirectPolicy: { kind: "follow"; maxRedirects: number } | { kind: "manual" } | { kind: "error" };
};

type DefaultAdapterHttpClientResponse = {
  status: number;
  reason: string;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
};
```

This is not public Voyd API.

### Runtime Behavior

Runtime adapters should implement `std::http::client` with the best available
native primitive:

- Node: `globalThis.fetch`
- Deno: `globalThis.fetch`
- Bun: `globalThis.fetch`
- Browser: `globalThis.fetch`
- Unknown: `runtimeHooks.httpClientRequest`, otherwise unsupported

Adapters should normalize response bodies as bytes. Text decoding belongs in
`http::Body::as_text` / `Response::text`, where errors can be represented in
Voyd.

## `std::http::server`

`std::http::server` should own inbound HTTP as a host capability.

Recommended effect id:

```voyd
@effect(id: "voyd.std.http.server")
```

### Public Types

```voyd
pub obj Server {
  pri id: i32
}

pub obj RequestHandle {
  pri id: i32
}

pub obj ServerConfig {
  api port: i32,
  api host?: String,
  api max_body_bytes?: i32,
  api max_pending_requests?: i32
}

pub obj PendingRequest {
  api handle: RequestHandle,
  api request: http::IncomingRequest
}
```

`RequestHandle` should be nominal and opaque. Application code should not pass
raw request ids around.

### Public Functions

```voyd
pub fn listen(config: ServerConfig): HttpServer -> Result<Server, HostError>

pub fn accept(server: Server): HttpServer -> Result<PendingRequest, HostError>

pub fn respond(
  handle: RequestHandle,
  response: http::Response
): HttpServer -> Result<Unit, HostError>

pub fn close(server: Server): HttpServer -> Result<Unit, HostError>
```

Every public effectful function must spell its effect row explicitly.

### Raw Effect Operations

The raw operations can stay DTO-shaped internally:

```voyd
pub eff HttpServer
  listen(tail, payload: MsgPack) -> MsgPack
  accept(resume, server_id: i32) -> MsgPack
  respond(tail, payload: MsgPack) -> MsgPack
  close(tail, server_id: i32) -> MsgPack
```

Those operations are implementation details of the std wrapper. They should not
be the documented user API.

### Lifecycle Semantics

The proposal should pin down these rules before implementation:

- `accept` suspends until a request is available or the server closes.
- each `RequestHandle` may be responded to exactly once.
- responding twice returns `HostError`.
- dropping a request without responding should produce a host-managed `500` or a
  closed connection; the exact behavior must be documented.
- `close` stops new accepts and releases host resources.
- if the client disconnects before `respond`, the result is `HostError`.
- request bodies are buffered up to `max_body_bytes`.
- requests beyond `max_pending_requests` are rejected or backpressured by the
  adapter according to documented runtime policy.

### Managed Loop Helper

The lower-level API should expose `listen`/`accept`/`respond`, but a safe helper
is useful even before the full web framework exists.

```voyd
pub fn serve_each({
  config: ServerConfig,
  handle: fn(http::IncomingRequest) : (open) -> http::Response
}): (HttpServer, TaskRuntime, open) -> Result<Unit, HostError>
```

This helper should:

- listen
- accept in a loop
- spawn or detach request tasks according to an explicit policy
- call the handler
- respond exactly once
- convert uncaught host/request lifecycle errors into useful diagnostics
- close the server on shutdown

`packages/web` can use this helper or own a more advanced loop, but the std
server module should make the safe path obvious.

## Host Adapter Support

`@voyd-lang/js-host` should provide default adapter capabilities for
`voyd.std.http.client` and `voyd.std.http.server`.

Recommended additions:

- `HTTP_CLIENT_EFFECT_ID = "voyd.std.http.client"`
- `HTTP_SERVER_EFFECT_ID = "voyd.std.http.server"`
- capability name: `"http-client"`
- capability name: `"http-server"`
- `packages/js-host/src/adapters/default/capabilities/http-client.ts`
- `packages/js-host/src/adapters/default/capabilities/http-server.ts`
- runtime hook types for client request and server listen/accept/respond/close
- conformance tests for capability registration and unsupported runtimes

Normalized host DTOs should be TypeScript implementation details:

```ts
type DefaultAdapterHttpRequest = {
  requestId: number;
  method: string;
  path: string;
  query?: string;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
};

type DefaultAdapterHttpResponse = {
  requestId: number;
  status: number;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
};
```

The Voyd API should expose `IncomingRequest`, `Response`, `Headers`, and `Body`,
not this DTO shape.

## Runtime Policy

Runtime differences belong in adapters.

Recommended runtime kinds:

- `node`
- `deno`
- `bun`
- `browser`
- `unknown`

Node should be the reference implementation:

- outbound HTTP client: `globalThis.fetch`
- inbound: `node:http`

Deno and Bun should use native serve APIs when available:

- Deno: `Deno.serve`
- Bun: `Bun.serve`

Browser should support `http-client` and report `http-server` as unsupported.

Unknown runtimes can support HTTP server only when the host provides explicit
runtime hooks. They can support HTTP client only when `globalThis.fetch` exists
or the host provides an explicit client request hook.

## SDK And CLI Support

Provide one easy Node-oriented entrypoint for common server usage after the std
and host pieces exist.

Possible package:

- `packages/http-node`
- published as `@voyd-lang/http-node`

Example:

```ts
import { serveVoydApp } from "@voyd-lang/http-node";

await serveVoydApp({
  entryPath: "./src/main.voyd",
  port: 3000,
});
```

This package can compile the app, create the host, register default adapters,
and run the entrypoint. It should be a convenience wrapper, not a second HTTP
runtime design.

## Relationship To VX And HTML

`std::http` should not depend on `std::vx`.

The web framework can provide:

- extension-style `html(response, node) -> Response`, usable as
  `Response::ok().html(node)` when imported
- `html::render(node) -> String`

Those helpers should use the current VX server-rendering path and evolve with
future VX typing improvements. A fully nominal VX render tree is valuable, but
the first HTTP/server milestone should not be blocked on a VX redesign.

The only hard requirement is that web authors should not need to manipulate raw
MessagePack to return HTML.

## Phasing

### Phase 1: HTTP Foundation

- add `std::http` values and pure helpers
- add hidden host codecs for HTTP values
- remove `std::fetch`
- add `std::http::client`
- add `std::http::server` wrappers
- implement outbound client support in `js-host`
- implement Node server support in `js-host`
- add public smoke coverage for a single request/response round trip

### Phase 2: Runtime Coverage And Ergonomics

- add Bun as an explicit runtime kind
- add Deno and Bun server backends
- add SDK/server helper package
- add managed loop helpers and shutdown tests
- add body limits and pending queue policy tests

### Phase 3: Advanced HTTP

- streaming bodies
- typed cookies
- multipart/form support
- richer content negotiation
- generic DTO-to-JSON encoding if the language/runtime exposes a stable path

## Testing Direction

Follow `docs/testing/ownership.md`.

- `packages/std`: pure HTTP values, builders, header behavior, codecs
- `packages/std`: HTTP client request builders and body behavior
- `packages/js-host`: adapter registration, Node server lifecycle, unsupported
  runtime behavior
- `packages/sdk` or helper package: server wiring
- `tests/integration`: public end-to-end server request/response behavior

Canonical end-to-end serving behavior should live in `tests/integration`.

## Recommendation

Build `std::http` as a small but serious protocol foundation: nominal where HTTP
has invariants, structural where configuration should stay lightweight, and
effectful only at the host boundary. Remove `std::fetch`, add
`std::http::client`, add `std::http::server`, and keep MessagePack as hidden
implementation machinery.

That gives the higher-level web framework a clean base without forcing framework
concerns into the standard library.
