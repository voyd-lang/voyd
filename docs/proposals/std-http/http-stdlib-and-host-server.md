# HTTP Stdlib and Host Server Support

Status: Proposed
Owner: Std + Runtime + SDK
Scope: `packages/std/src/http*`, `packages/js-host`, `packages/js-host/src/runtime/*`, optional SDK helper package

## Summary

To support a first-class Voyd web framework, we should add a small HTTP-focused
stdlib surface and one host-backed server capability.

The most important conclusion is:

- no new core language semantics are required for the MVP
- we do need new std/runtime support

The framework can prototype without these additions, but it will not feel
native or maintainable until the stdlib exposes canonical HTTP values and the
host runtime can deliver inbound requests.

## Current Gaps

Today we have:

- `std::fetch` for outbound HTTP
- `std::json` for JSON values
- `std::bytes` for raw payloads
- `std::task` and `std::time` for concurrency and timers
- `std::log` for structured logging
- MessagePack-backed host DTO patterns

What we do not have:

- canonical shared HTTP request/response types
- inbound HTTP server support
- binary/body-aware HTTP primitives suitable for both client and server
- a documented host path for serving Voyd handlers over Node/Bun/Deno

## Recommendation

Add two layers:

1. `std::http`
2. `std::http::server`

Then refactor `std::fetch` to reuse `std::http` instead of owning its own
private HTTP value model.

Breaking changes are acceptable here. We should optimize for the best long-term
HTTP surface, not for preserving the current `std::fetch` API shape.

## Success Criteria

This proposal is successful when all of the following are true:

- `std::http` exists as the canonical shared HTTP value model.
- `std::fetch` has been refactored to use `std::http` types internally and
  publicly where appropriate.
- `std::fetch` no longer defines the ecosystem's primary HTTP request/response
  model.
- `std::vx` no longer exposes raw `MsgPack` as its primary public render-tree
  type.
- `std::vx` exposes a typed nominal render-tree model suitable for HTML
  templating and server rendering.
- the existing HTML reader macro lowers directly into the redesigned typed
  `std::vx` surface.
- `std::http::server` exists as the canonical inbound HTTP server effect.
- `@voyd-lang/js-host` can host `voyd.std.http.server` with consistent DTO
  semantics across supported runtimes.
- runtime differences are normalized in adapters rather than leaking into Voyd
  APIs.
- `apps/smoke` proves end-to-end request handling through the public runtime.

## 1. New `std::http` Module

`std::http` should be pure. It should not listen on sockets or depend on the
host runtime.

Recommended contents:

- `Method`
- `Status`
- `Header`
- `Headers`
- `Request`
- `Response`
- `Body`
- `Cookie` later, not required for MVP
- MessagePack encode/decode helpers for host boundaries

### Proposed Types

```voyd
pub obj Header {
  api name: String,
  api value: String
}

pub type Headers = Array<Header>

pub obj MethodGet {}
pub obj MethodPost {}
pub obj MethodPut {}
pub obj MethodPatch {}
pub obj MethodDelete {}
pub obj MethodOptions {}
pub obj MethodHead {}
pub obj MethodOther {
  api value: String
}

pub type Method =
  MethodGet
  | MethodPost
  | MethodPut
  | MethodPatch
  | MethodDelete
  | MethodOptions
  | MethodHead
  | MethodOther

pub obj BodyEmpty {}
pub obj BodyText {
  api value: String
}
pub obj BodyBytes {
  api value: Bytes
}

pub type Body = BodyEmpty | BodyText | BodyBytes

pub obj Request {
  api method: Method,
  api path: String,
  api query?: String,
  api headers: Headers,
  api body: Body
}

pub obj Response {
  api status: Status,
  api headers: Headers,
  api body: Body
}
```

For the MVP, request bodies can be fully buffered. Streaming can come later.

### Pure Helpers

Recommended helpers:

- `Request::header(name) -> Option<String>`
- `Response::ok() -> Response`
- `Response::bad_request() -> Response`
- `Response::not_found() -> Response`
- `Response::with_header(name, value) -> Response`
- `Response::text(value) -> Response`
- `Response::json(value: JsonValue) -> Response`
- `Response::bytes(value: Bytes) -> Response`
- `method_from_string(...)`
- `status(code, text?)`

Every public string-taking helper should provide both `String` and
`StringSlice` overloads, matching existing std conventions.

### Host Boundary Codecs

`std::http` should own the canonical MessagePack DTO encoding/decoding used by
the runtime boundary.

Recommended functions:

- `encode_request(request: Request) -> MsgPack`
- `decode_request(payload: MsgPack) -> Result<Request, HttpError>`
- `encode_response(response: Response) -> MsgPack`
- `decode_response(payload: MsgPack) -> Result<Response, HttpError>`

This should follow the same maintainable pattern already used by `std::fetch`,
`std::fs`, `std::env`, and `std::input`:

- stable effect ids
- explicit DTO encoding/decoding
- typed wrappers around `MsgPack`

## 2. Refactor `std::fetch`

We should change `std::fetch` to depend on `std::http`, not the other way
around.

### Why

Right now `std::fetch` owns:

- headers
- request structure
- response structure
- text-body assumptions

That is enough for a client helper, but it is the wrong place to define the
shared HTTP model the rest of the ecosystem should use.

### Direction

Keep `std::fetch` as the outbound client API, but refactor it to reuse:

- `std::http::Header`
- `std::http::Headers`
- `std::http::Request`
- `std::http::Response`
- `std::http::Body`

`std::fetch` can then add only client-specific concerns:

- timeout budget
- redirect policy later
- client convenience helpers like `get` and `post`

This is the biggest stdlib shape change I would recommend.

### Concrete Refactor Sketch

Recommended end state:

```voyd
use std::http

pub obj FetchRequest {
  api request: http::Request,
  api timeout_millis?: i32
}

pub type FetchResponse = http::Response
```

Recommended body model changes:

- stop treating request/response bodies as text-only in the shared model
- make `http::Body` the canonical body type
- let `std::fetch` provide text-oriented convenience helpers on top

Recommended API shape:

```voyd
pub fn request(request: FetchRequest): Fetch -> Result<FetchResponse, HostError>

pub fn get(url: String): Fetch -> Result<FetchResponse, HostError>
pub fn post({ url: String, body: http::Body }): Fetch -> Result<FetchResponse, HostError>
```

Recommended convenience methods:

- `FetchRequest::from_get(url)`
- `FetchRequest::from_post({ url, body })`
- `FetchRequest::with_header(...)`
- `FetchRequest::with_timeout(...)`
- body decoding helpers layered on `http::Body`, not embedded into the shared
  response shape

### Breaking Changes We Should Accept

These are worth taking:

- replace `FetchResponse.body: String` with `http::Body`
- replace `FetchRequest.body?: String` with `http::Body`
- move header/request/response canonical definitions into `std::http`
- remove duplication between `std::fetch` DTO codecs and `std::http` DTO codecs

If compatibility shims are helpful during migration, they should be thin and
temporary.

## 3. New `std::http::server` Effect

The framework needs a host-owned inbound HTTP capability. This should live in a
dedicated effect rather than being smuggled through unrelated APIs.

Recommended effect id:

```voyd
@effect(id: "voyd.std.http.server")
```

### Proposed Surface

```voyd
pub obj Server {
  api id: i32
}

pub obj ServerConfig {
  api port: i32,
  api host?: String
}

pub obj PendingRequest {
  api request_id: i32,
  api request: http::Request
}

pub eff HttpServer
  listen(tail, payload: MsgPack) -> MsgPack
  accept(resume, server_id: i32) -> MsgPack
  respond(tail, payload: MsgPack) -> MsgPack
  close(tail, server_id: i32) -> MsgPack
```

Voyd-facing helpers:

- `listen(config: ServerConfig): HttpServer -> Result<Server, HostError>`
- `accept(server: Server): HttpServer -> Result<PendingRequest, HostError>`
- `respond(request_id: i32, response: http::Response): HttpServer -> Result<Unit, HostError>`
- `close(server: Server): HttpServer -> Result<Unit, HostError>`

### Why This Shape Fits Voyd

- the host still owns sockets and the event loop
- Voyd code owns routing and response construction
- `accept(resume, ...)` suspends naturally until work arrives
- request handling can spawn child tasks explicitly
- cancellation can propagate through the task runtime

### Request Loop Example

```voyd
use std::http::server::self as server
use std::task::self as task

pub fn main(): (server::HttpServer, task::TaskRuntime) -> i32
  let active = server::listen({ port: 3000 })
  match(active)
    Err<HostError>:
      1
    Ok<Server> { value }:
      run_server(value)

fn run_server(listener: server::Server): (server::HttpServer, task::TaskRuntime) -> i32
  while true:
    match(server::accept(listener))
      Ok<PendingRequest> { value }:
        let _ = task::detach(() => handle_request(value))
      Err<HostError>:
        break
  0
```

## 4. Break `std::vx` Toward A Typed Render Tree

If VX is going to be the canonical HTML/template story for Voyd web work, we
should fix it in std instead of hiding the problem in the framework.

Today `std::vx` is effectively a thin MsgPack construction helper. That is too
low-level for a long-term templating/rendering surface.

### Recommendation

Take a breaking change in `std::vx` so its primary public API is a typed render
tree rather than raw `MsgPack`.

Recommended direction:

```voyd
pub obj VxText {
  api value: String
}

pub obj VxElement {
  api name: String,
  api attributes: VxAttributes,
  api children: Array<VxNode>
}

pub type VxNode = VxText | VxElement
```

Suggested supporting types:

- `VxNode`
- `VxElement`
- `VxText`
- `VxAttributeValue`
- `VxAttributes`

Then make MsgPack conversion an implementation detail or an explicit interop
helper:

- `vx::to_msgpack(node: VxNode) -> MsgPack`
- `vx::from_msgpack(...)` only if genuinely needed

The existing HTML reader macro should be updated as part of this work so HTML
syntax lowers into the new typed VX model rather than into raw MsgPack-shaped
construction helpers.

### Current Reader Macro Behavior To Preserve Or Intentionally Change

The implementor should not need to rediscover the current parser behavior.
Today the HTML reader macro:

- only triggers when `<` appears after whitespace and the next character is a
  letter
- avoids stealing parses from numeric comparisons and generic angle brackets
- lowers built-in tags to `create_element(...)`
- lowers capitalized tags as component calls
- lowers namespaced components like `UI::Card` through nested `::` surface
  calls
- parses `{...}` interpolation by delegating back into the ordinary reader
- unwraps single-expression interpolations
- collapses text-node whitespace in normal mode
- preserves literal whitespace inside `<pre>` and `<textarea>`
- lowers boolean attributes as the string `"true"`
- requires quoted string attribute values unless the value is an interpolated
  `{...}` expression

Those rules currently live in:

- `packages/compiler/src/parser/reader-macros/html/html.ts`
- `packages/compiler/src/parser/reader-macros/html/html-parser.ts`

### Reader Macro Update Required By This Proposal

The redesign should preserve the good parsing behavior above, but change the
lowering target.

Specifically:

- built-in tags should no longer lower to `create_element(...)` returning raw
  MsgPack
- built-in tags should lower to the new typed VX constructors
- component lowering should continue to work, but `children` should become
  typed `Array<VxNode>` values
- interpolated text and child expressions should lower into typed VX nodes or
  typed child arrays rather than ad hoc MsgPack payloads

Recommended lowering direction:

- built-in element: `vx::element({ name, attributes, children })`
- text node: `vx::text("...")`
- component: function call with a typed props object, including typed
  `children`

### Specific Migration Work

At minimum, the implementation should:

- update `html-parser.ts` built-in element lowering away from `create_element`
- update child-array construction away from MsgPack-shaped arrays
- update attribute lowering away from `Array<Array<MsgPack>>`
- update parser tests and snapshots that currently assert `create_element`
- add dedicated tests for typed VX output from HTML syntax
- keep inline-lambda interpolation behavior working
- keep `<pre>` / `<textarea>` whitespace preservation working
- keep namespaced component parsing working

### Breaking Changes We Should Accept

These are worth taking:

- change `vx::create_element(...)` to return `VxNode` or `VxElement`
- stop exposing raw `MsgPack` as the canonical VX node type
- change children and attributes to typed VX values instead of ad hoc MsgPack
  arrays

### Why This Belongs In Std

The framework should decide how HTML becomes an HTTP response.

It should not have to compensate for std exposing the wrong render-tree shape.

The better layering is:

- `std::vx`: typed render tree / template authoring
- `std::http`: typed HTTP values
- framework: routing, middleware, response conversion, HTML response helpers

### Sketch

Recommended end state:

```voyd
use std::vx

fn home_page(): vx::VxNode
  vx::element({
    name: "main",
    children: [
      vx::element({
        name: "h1",
        children: [vx::text("Voyd Web")]
      }),
      vx::element({
        name: "p",
        children: [vx::text("Typed HTML templates.")]
      })
    ]
  })
```

The web framework can then provide:

- `Response::html(node: vx::VxNode) -> Response`
- `html::render(node: vx::VxNode) -> String`

That is a much better split than making framework users manipulate raw MsgPack.

## 5. Host-Side Support

If we add a new std module and server effect, we should support it in the host
layer the same way we support `fs`, `fetch`, `time`, and `log`.

Short answer: yes, we do need to update host adapters for this proposal.

### JS Host Changes

Add a new default adapter capability:

- file: `packages/js-host/src/adapters/default/capabilities/http-server.ts`
- capability id: `"http-server"`
- effect id: `"voyd.std.http.server"`

Add matching runtime-hook support in
`packages/js-host/src/adapters/default/types.ts`.

Suggested runtime hook family:

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

The adapter should manage:

- a server registry keyed by `server_id`
- a queue of pending inbound requests
- pending host response resolvers keyed by `request_id`
- cancellation when the client disconnects

### Existing Adapter Changes

This proposal also requires changes to existing host adapters, not just a new
one.

Required updates:

- update `voyd.std.fetch` adapter inputs/outputs to use the new shared
  `std::http` DTO shape
- add `http-server` to the default capability registration list
- extend capability reporting to include HTTP server support
- add runtime hooks for server listen/accept/respond/close
- extend conformance tests to cover the new server capability

## 6. Runtime Strategy in `js-host`

We should handle runtime differences with a normalized capability layer, not by
forking the Voyd API per runtime.

### Current State

`js-host` currently models these runtimes:

- `node`
- `deno`
- `browser`
- `unknown`

It does not currently expose a first-class `bun` runtime kind.

### Proposed Runtime Policy

Add `bun` as an explicit `HostRuntimeKind` in `packages/js-host/src/runtime/*`.

Recommended runtime kinds after this proposal:

- `node`
- `deno`
- `bun`
- `browser`
- `unknown`

Even if Bun is Node-compatible for some APIs, making it explicit gives us:

- accurate diagnostics
- runtime-specific adapter choices when they matter
- room for Bun-native HTTP serving without pretending it is just Node

### Capability-First Normalization

Each runtime should normalize into the same internal DTOs:

- `DefaultAdapterHttpRequest`
- `DefaultAdapterHttpResponse`
- `DefaultAdapterFetchRequest`
- `DefaultAdapterFetchResponse`

Voyd code should never branch on runtime.

The adapter layer should choose the backend.

### Runtime Backends

#### Node

Use:

- `globalThis.fetch` for outbound client requests
- `node:http` for inbound HTTP server support

Node should be the reference implementation and the first runtime we fully
prove in smoke tests.

#### Deno

Use:

- `globalThis.fetch` for outbound client requests
- `Deno.serve` for inbound HTTP server support when available

The adapter should buffer request bodies and translate Deno request/response
objects into the normalized DTOs.

#### Bun

Use:

- `globalThis.fetch` for outbound client requests
- `Bun.serve` for inbound HTTP server support when available

This is the main reason to add an explicit `bun` runtime kind. Bun's server
APIs are close in spirit to web-standard fetch objects, but operationally they
are not the same thing as Node's `node:http`.

#### Browser

Use:

- `globalThis.fetch` for outbound client requests
- mark `http-server` as unsupported

That should be reported cleanly through capability registration, just like the
current `fs` browser behavior.

#### Unknown

Policy:

- use `runtimeHooks.fetchRequest` if provided
- use `runtimeHooks.httpServer*` hooks if provided
- otherwise register `fetch` or `http-server` as unsupported

This keeps the runtime extensible for custom embeddings.

### Recommended Runtime Hook Shape

I recommend expanding `DefaultAdapterRuntimeHooks` with an HTTP server hook
family instead of overfitting to one runtime:

```ts
type DefaultAdapterHttpServerHandle = {
  serverId: number;
};

type DefaultAdapterRuntimeHooks = {
  fetchRequest?: (
    request: DefaultAdapterFetchRequest
  ) => Promise<DefaultAdapterFetchResponse>;
  httpServerListen?: (
    config: { host?: string; port: number }
  ) => Promise<DefaultAdapterHttpServerHandle>;
  httpServerAccept?: (
    handle: DefaultAdapterHttpServerHandle
  ) => Promise<DefaultAdapterHttpRequest>;
  httpServerRespond?: (
    response: DefaultAdapterHttpResponse
  ) => Promise<void>;
  httpServerClose?: (
    handle: DefaultAdapterHttpServerHandle
  ) => Promise<void>;
};
```

The default adapters can provide native implementations per runtime, while
custom hosts can override them all with hooks.

## 7. Node Reference Implementation

The first-class reference should be Node-based.

Implementation direction:

- use `node:http`
- buffer the full request body into `Uint8Array`
- normalize headers into repeated `{ name, value }` entries
- hand the DTO into Voyd through `accept`
- wait for Voyd to call `respond`
- write the buffered response back to `ServerResponse`

That is enough for an MVP and keeps the adapter small.

## 8. SDK / Package Support

We should also provide a high-level helper so users do not need to manually wire
hosts for common server cases.

Recommended direction:

- new package: `packages/http-node`
- published entrypoint such as `@voyd-lang/http-node`

Example:

```ts
import { serveVoydApp } from "@voyd-lang/http-node";

await serveVoydApp({
  entryPath: "./src/main.voyd",
  port: 3000,
});
```

This package can compile the source, create the JS host, register default
adapters including `voyd.std.http.server`, and run the chosen entrypoint.

## 9. Do We Need Language Changes?

For the MVP: no.

Effects, tasks, objects, traits, overloads, and MessagePack host interop are
already enough.

### Optional Language / Tooling Follow-Ups

These are useful, but not blockers:

- document and stabilize public `@serializer(...)` usage for user-facing types
- add derive-like serializer generation for MsgPack DTOs
- consider macro helpers for reducing HTTP DTO boilerplate

Those would improve ergonomics, but the framework should not wait on them.

## 10. A Small Additional Std Improvement

I would also consider a modest refactor to reduce duplicated DTO decoding logic
across std modules.

Candidate direction:

- add a few more `HostDto` read helpers for optional values and arrays

That is not required for the web framework, but it would make `std::http`,
`std::fetch`, and other host-backed modules easier to maintain.

## 11. Phasing

### Phase 1

- land `std::http` pure value types and codecs
- refactor `std::fetch` onto `std::http`
- redesign `std::vx` around a typed render tree
- accept breaking changes to fetch body/response types
- add `bun` as an explicit host runtime kind
- land `voyd.std.http.server` in `js-host` for Node first

### Phase 2

- add Deno and Bun native server backends
- add SDK/server package helpers
- expand smoke coverage across supported runtimes where practical

## Testing Direction

Keep ownership clean:

- `packages/std`: HTTP types, codecs, helpers
- `packages/std`: VX typed render-tree APIs and HTML rendering helpers
- `packages/js-host`: adapter contract and runtime behavior
- `packages/http-node` or SDK helper: wiring tests
- `apps/smoke`: full request/response round trips through public APIs

Canonical request-serving behavior should be proven in `apps/smoke`.

## Recommendation

Add `std::http`, add `std::http::server`, and refactor `std::fetch` onto the
shared HTTP model. Break `std::vx` toward a typed render tree at the same time
so HTML rendering has the right foundation in std. Yes, this proposal requires
host-adapter changes. Runtime differences should be handled in `js-host` via
explicit runtime profiles and normalized DTOs, with `bun` promoted to a
first-class runtime kind rather than being treated implicitly.
