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
- Typed JSON and MessagePack APIs share the provider-neutral data reader and
  writer contract. Their typed paths stream directly instead of constructing a
  `DataValue` tree first.
- `CustomDto<T>` can define a type's boundary representation and conversion
  functions. The representation participates in the canonical DTO plan.
- The `@boundary` and `@serializer` annotations have been removed.
- Standard host effects for logging, randomness, environment variables,
  input, output, time, task failures, filesystems, and HTTP now use typed request
  and result values. Adapter authors receive and return those values instead of
  MessagePack envelope objects.
- HTTP and filesystem byte bodies are `Uint8Array` values in JavaScript host
  adapters.
- VX component state is generic and typed. The serialized `MsgPack` state
  overloads and `set_serialized`/`update_serialized` methods have been removed.
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

This record will be extended as the remaining obsolete boundary and VX APIs are
removed.
