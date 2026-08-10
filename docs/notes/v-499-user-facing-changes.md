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
  filesystems, and HTTP now use typed request and result values. Adapter authors
  receive and return those values instead of MessagePack envelope objects.
- HTTP and filesystem byte bodies are `Uint8Array` values in JavaScript host
  adapters.

This record will be extended as the remaining obsolete boundary and VX APIs are
removed.
