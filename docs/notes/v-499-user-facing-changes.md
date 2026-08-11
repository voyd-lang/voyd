# V-499 user-facing changes

V-499 is an intentionally breaking replacement of the old MessagePack-specific
host boundary with compiler-derived DTO plans and a negotiated host transport.
The language is pre-adoption, so removed surfaces have no compatibility layer.

## Changes

- Public exports, external imports, effects, and retained callbacks use the
  framed host ABI v2 protocol. Host adapters must declare a compatible
  transport provider before user code runs.
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
- The `@boundary` and `@serializer` annotations have been removed.
- Standard host effects for logging, randomness, environment variables,
  input, output, time, task failures, filesystems, and HTTP now use typed request
  and result values. Adapter authors receive and return those values instead of
  MessagePack envelope objects.
- Typed `Unit` values use their structural JavaScript representation `{}` in
  host adapter payloads. Voyd `void` results use JavaScript `undefined`.
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
  together with frame encoding and decoding. Default adapters use this hook to
  enforce transport buffer limits without depending on a concrete wire format.
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
- Canvas wrapper payloads are private. Construct paths, draws, gradients, and
  frames through the typed canvas API.
- Canvas paths, draws, gradients, and frames now use one typed custom DTO
  representation at host boundaries. `Point` and `Transform` are immutable
  objects so nested optional canvas fields have a stable DTO layout.
- VX events, HTML/program mappers, and canvas measurement commands no longer
  accept caller-owned numeric handler IDs or raw MessagePack callbacks. Use
  typed message values and typed closures; the runtime owns callback
  capabilities and their lifetime.
- `Html<Msg>`, `Attr<Msg>`, `Program<Model, Msg>`, and `Sub<Msg>` are opaque.
  The public `HtmlNode` and `HtmlAttr` names and their wire payload fields have
  been removed. Static HTML and attributes use the message-neutral `void`
  specialization. HTML, command,
  subscription, program, and canvas composition now retains typed semantic
  plans and creates the private MessagePack renderer wire only at the VX host
  boundary.
- `Cmd::task(work:, handler:)` has been removed. Use
  `Cmd::perform(work:, handler:)` or pass an existing `Task<T>` with
  `Cmd::perform(task:, handler:)`.
- `std::web::render` and `render_static` accept typed VX HTML only; the raw
  MessagePack overloads have been removed.

Obsolete boundary annotations, intrinsic names, raw VX constructors, and
MessagePack-specific compatibility paths were removed rather than deprecated.
