# V-499 user-facing changes

This is the living record of user-facing changes made while implementing
`docs/proposals/encoding-and-vx-dto.md`. The implementation is one breaking
change. Compatibility aliases and deprecated forms are intentionally omitted.

## Implemented

- `Bytes` is a distinct automatic DTO primitive and appears as `BytesShape` in
  reified type shapes.
- `DataValue` includes `DataBytes`.
- `std::data::encode<T>` converts an eligible value into its provider-neutral
  `DataValue` representation.
- `std::data` defines balanced `DataWriter` and pull-based `DataReader`
  contracts, with explicit depth, byte, and collection-size limit types.
  `DataValueWriter` and `DataValueReader` provide checked tree bridges for
  callers that need an explicit neutral value.
- DTO decoding rejects unknown fields by default. Callers must explicitly use
  `IgnoreUnknownFields` for forward-compatible input.
- Export, effect, and external-package DTO schemas carry stable SHA-256
  fingerprints at every typed payload position.
- Every closed eligible type now has one cached `AutoDtoPlan` in
  `ProgramCodegenView`. Shape reification, schema metadata, fingerprints, and
  generated traversal consume that canonical plan.
- Wasm modules declare their host ABI, DTO schema ABI, and selected transport.
  Host ABI v2 will replace the current unframed ABI when complete frame support
  is enabled.
  The JavaScript host rejects missing or incompatible transport metadata before
  running user code.
- The JavaScript SDK can register host transport adapters through
  `transportAdapters`.
- Serialized export calls use versioned invocation and completion frames with
  export identity, normalized outcomes, and schema fingerprints.
- Synchronous external-package calls use the same module transport frames and
  validate interface, function, argument, and result schema identities.
- Effect requests and outcomes use framed transport with stable effect and
  operation identity, signature hash, resume kind, and typed payload
  fingerprints. This also covers asynchronous external-package calls.
- Retained callback invocations and non-effectful callback completions use
  invocation-scoped frames. Effectful callbacks use the same framed effect
  request/outcome loop.
- Generated TypeScript adapter contracts represent `Bytes` as `Uint8Array`;
  generated WIT represents it as `list<u8>`.
- OpenAPI shape rendering represents `Bytes` as a binary string.
- `ByteBuffer.push` traps when given an integer outside `0...255`; invalid
  values can no longer be silently truncated during encoding.
- `std::msgpack::encode<T>` returns immutable `Bytes`, and
  `std::msgpack::decode<T>` decodes immutable bytes into a checked DTO value.
  Parsed-tree byte conversion remains available as `encode_value_bytes` and
  `decode_value_bytes`.
- `MsgPackWriter` and `MsgPackReader` implement the provider-neutral data
  contracts directly over immutable MessagePack bytes, including balanced
  containers and allocation-free value skipping.
- Typed MessagePack encoding and decoding now use those byte streams and no
  longer construct an intermediate parsed `MsgPack` tree.
- `std::json::encode<T>` produces compact JSON and rejects `i64` values outside
  JavaScript's exact integer range. `Bytes` requires an explicit application
  representation in JSON.
- `JsonWriter` implements the provider-neutral data writer contract directly
  over compact UTF-8 JSON output. Typed JSON encoding no longer constructs an
  intermediate `JsonValue` tree.

## Planned removals and replacements

- Remove `@boundary` and `@serializer` syntax and metadata.
- Remove public MessagePack boundary helpers and compiler contracts.
- Replace format-specific compiler traversal with the single `AutoDtoPlan`
  exposed through `ProgramCodegenView`.
- Generate typed JSON and MessagePack traversal directly against `DataReader`
  and `DataWriter` without constructing an intermediate `DataValue` tree.
- Replace raw VX MessagePack payloads with typed plans and final wire lowering.
- Replace the legacy unframed host protocol with complete ABI v2 frames.
- Add custom DTO representations for types that cannot use automatic structural
  DTO derivation.
