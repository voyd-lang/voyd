# V-499 user-facing changes

V-499 is an intentionally breaking replacement of the old MessagePack-specific
host boundary with compiler-derived DTO plans and a negotiated host transport.
The language is pre-adoption, so removed surfaces have no compatibility layer.

## Changes

- Public exports, external imports, effects, and retained callbacks use the
  framed host ABI v2 protocol. Host adapters must declare a compatible
  transport provider before user code runs.
- Host transport implementations declare their static identity with
  `@host_transport(id: ..., version: ...)` on a stateless object that implements
  the compiler-known `HostTransportProvider` trait. Duplicate or mismatched
  declarations fail compilation.
- Export, import, effect, and callback values use compiler-derived DTO shapes
  and schema fingerprints. Plain JavaScript values remain the SDK surface.
- `Bytes` is a first-class DTO primitive and crosses JavaScript boundaries as
  `Uint8Array`.
- `ByteBuffer::push` rejects values outside `0...255`; byte encoding no longer
  truncates out-of-range integers modulo 256.
- DTO encoding rejects cyclic object graphs and values that exceed the maximum
  traversal depth instead of manufacturing a string-shaped sentinel value.
- Typed JSON and MessagePack APIs share the provider-neutral data reader and
  writer contract. Typed encoding and decoding traverse those streams directly
  without allocating a `DataValue` tree. Explicit `JsonValue`, `MsgPack`, and
  `DataValue` trees remain available for callers that intentionally need dynamic
  values.
- `CustomDto<T>` can define a type's boundary representation and conversion
  functions. The representation participates in the canonical DTO plan.
  `CustomDtoError` now requires a stable `code` in addition to its diagnostic
  message.
- The `@boundary` and `@serializer` annotations have been removed.
- Standard host effects for logging, randomness, environment variables,
  input, output, time, task failures, filesystems, and HTTP now use typed request
  and result values. Adapter authors receive and return those values instead of
  MessagePack envelope objects.
- Typed `Unit` values use their structural JavaScript representation `{}` in
  host adapter payloads. Voyd `void` results use JavaScript `undefined`.
- Optional record fields are represented by omission. Supplying `null` is a
  type error unless the declared DTO representation explicitly accepts null.
- Typed decoding rejects unknown record and variant fields by default. Pass
  `DecodeOptions { unknown_fields: IgnoreUnknownFields {} }` when a boundary
  intentionally accepts additional fields.
- HTTP and filesystem byte bodies are `Uint8Array` values in JavaScript host
  adapters.
- VX component state is generic and typed. The serialized `MsgPack` state
  overloads and `set_serialized`/`update_serialized` methods have been removed.
- `std::error::panic()` is available for allocation-free traps when no
  diagnostic message is needed.
- `std::host_dto::HostDto` has been removed. Host effects declare ordinary
  typed request and result records directly.
- `std::json::encode_value<T>` produces an explicit `JsonValue` tree from the
  shared DTO plan. Web responses and OpenAPI helpers no longer route typed JSON
  through MessagePack.
- `effectsHostBoundary` now accepts `"selected"` or `"off"`; the compiler
  loads and retains the build-selected transport provider only for host-facing
  code that needs it.
- Custom JavaScript host transport adapters must provide `encodedPayloadSize`
  and `decodePayload` together with frame encoding and decoding. Default
  adapters use these hooks to enforce transport buffer limits and decode nested
  typed VX payloads without depending on a concrete wire format.
- Host failure frames now preserve direction, frame category, transport phase,
  failure category, provider error code, and structural path. Custom transport
  adapters must encode and decode the complete failure record.
- Web route parameters, query values, headers, and cookies decode through the
  provider-neutral DTO data model. Rejection messages now identify failures
  with rooted DTO paths such as `$.page`.
- `Cmd<Msg>` no longer exposes its wire payload, raw runtime command
  construction, serialized message/delay constructors, serialized mapper
  overloads, or caller-supplied handler IDs. Use the typed command constructors
  and typed closure overloads.
- `Sub<Msg>` no longer exposes its wire payload, raw runtime subscription
  construction/configuration, serialized interval and keyboard constructors,
  serialized mapper overloads, or caller-supplied handler IDs. Use typed
  built-in constructors and typed closure overloads; custom host listeners
  belong in versioned effect or external packages.
- `std::msgpack` no longer exposes boundary-tree packing/unpacking helpers.
  Use typed `encode`/`decode` for bytes, or explicitly convert between
  `MsgPack` and the neutral `DataValue` tree with `from_data_value` and
  `to_data_value`.
- Web JSON bodies and authorization values now decode through typed JSON and
  neutral DTO data. Passing the dynamic `JsonValue` type through a generic
  typed body route is no longer supported; use a typed request DTO.
- Canvas DTO wrappers are no longer exported from the canvas module. Construct
  paths, draws, gradients, and frames through the typed canvas API.
- Canvas frame version 1 has been removed. The VX DOM renderer accepts only
  version 2 canvas frames.
- Canvas paths, draws, gradients, and frames now use one typed custom DTO
  representation at host boundaries. `Point` and `Transform` are immutable
  objects so nested optional canvas fields have a stable DTO layout.
- VX events, HTML/program mappers, and canvas measurement commands no longer
  accept caller-owned numeric handler IDs or raw MessagePack callbacks. Use
  typed message values and typed closures; the runtime owns callback
  capabilities and their lifetime.
- Runtime-issued task and callback capabilities are opaque, scoped to their
  issuing runtime, and never reused. Guessed, cross-runtime, released, or
  completed capabilities are rejected.
- `Html<Msg>`, `Attr<Msg>`, `Program<Model, Msg>`, and `Sub<Msg>` are opaque.
  The public `HtmlNode` and `HtmlAttr` names and their wire payload fields have
  been removed. Static HTML and attributes use the message-neutral `void`
  specialization. HTML, command,
  subscription, program, and canvas composition now retains typed semantic
  plans and creates a provider-neutral renderer wire only at the VX host
  boundary.
- VX plans are lowered lazily when their DTO representation crosses a host or
  server-rendering boundary. Building and combining plans no longer performs
  an eager encode/decode cycle.
- VX boundaries use typed structural wires. Erased model, message, command,
  subscription, canvas, state, keyed-scope, and task-key leaves carry immutable
  encoded bytes together with their DTO fingerprint. The former public
  `DataValue`/MessagePack plan maps and `kind: "msgpack"` wrapper are removed.
  Nested payloads are decoded by the module-selected transport and rejected
  unless their fingerprint was emitted for that module.
- The structural wire declarations used by the separate `std` and `web`
  packages remain addressable as cross-package SSR plumbing. They are not a
  supported construction API; application-facing raw lowerers and DTO wrapper
  constructors have been removed where the package boundary does not require
  them.
- Server rendering walks the typed HTML and attribute wire directly; it no
  longer materializes a `DataValue`, JSON, or MessagePack tree.
- Component-local state, keyed scopes, and task keys use fingerprinted encoded
  payloads. Values with a mismatched DTO fingerprint are rejected before typed
  decoding.
- `std::web` HTML rendering accepts `Html<Msg>` for any message type, so
  server-rendered event handlers keep their real message type. The public raw
  `std::vx::lower_html` byte escape hatch has been removed.
- `@voyd-lang/vx-dom` no longer exports `decodeVxWire`, `callComponentFn`,
  `resolveMemory`, the direct Wasm `render` helper, or `renderMsgPackNode`.
  Mount, hydration, and server rendering accept a negotiated app runtime or a
  decoded VX frame. Use `renderVxNode` when rendering an already decoded tree.
- Legacy VX callback imports and legacy `{ name, attributes }` HTML trees have
  been removed. VX integrations must use the current typed callback and HTML
  frame contracts.
- Static `Html<void>` and `Attr<void>` values compose into message-bearing VX
  elements without erasing the element's inferred message union.
- `Cmd::task(work:, handler:)` has been removed. Use
  `Cmd::perform(work:, handler:)` or pass an existing `Task<T>` with
  `Cmd::perform(task:, handler:)`.
- `Task.id` and `Cmd::perform(task_id:, handler:)` have been removed. Task
  observation accepts only task capabilities created by `spawn` or `detach`.
- `std::web::render` and `render_static` accept typed VX HTML only; the raw
  MessagePack overloads have been removed.

Obsolete boundary annotations, intrinsic names, raw VX constructors, and
MessagePack-specific compatibility paths were removed rather than deprecated.
