# DTO, Type Shapes, and Host Boundaries

Status: Draft for discussion

## Goal

> Create one provider-neutral DTO and type-shape system for compiler and host
> boundaries.

This proposal replaces the current MessagePack-specific boundary and
serializer machinery. It makes automatic conversion at the SDK boundary a
normal consequence of a type's DTO plan. It also gives JSON, MessagePack, and
future structured formats one shared structural contract without making any of
them part of compiler semantics.

The result keeps the ordinary SDK experience:

```voyd
pub obj Profile {
  name: String,
  age: i32
}

pub fn echo(profile: Profile) -> Profile
  profile
```

```ts
const profile = await module.echo({ name: "Ada", age: 42 });
profile.name; // "Ada"
```

Application code does not encode this value to call the host. The compiler and
SDK do that automatically with the module's selected host transport.

## Non-goals

- This does not make JSON or MessagePack compiler concepts.
- This does not preserve `@boundary`, `@serializer`, their intrinsics, or raw
  VX MessagePack APIs for compatibility.

`std::encoding` remains the home for byte/text transformations such as base64
and hex. Structured formats own their own APIs.

## Terms

- **DTO** is the structural data representation of a Voyd type at a boundary.
  It has fields, arrays, variants, primitives, and bytes; it has no object
  identity, behavior, borrowed references, capabilities, or host handles.
- **Shape** describes that structural representation.
- **Auto DTO** means the compiler derives that representation and its
  conversion rules automatically.
- **Data reader/writer** is a provider-neutral structural input/output stream.
- **Host transport** is the outer bytes protocol used between Wasm and the SDK.
  It is distinct from an application's use of JSON or MessagePack files.

## Existing foundation

This proposal reuses and migrates real pieces of the current system. It is not
a greenfield design.

- `std::meta` already provides `Shape` and `shape_of`.
- `std::data` already provides `DataValue`, `DecodeOptions`, structural
  validation, and `data::decode`.
- Typed JSON already follows `JsonValue -> DataValue -> data::decode`.
- The compiler already derives boundary schema and emits the JavaScript
  validation metadata used by the SDK.
- MessagePack already has its own value tree and encoding implementation.

Those pieces do not yet form the provider-neutral system described here.
`DataValue` does not yet have `Bytes`, and `data::encode` does not exist. There
is no `DataReader` or `DataWriter`. Today `std::data` imports MessagePack and
uses a MessagePack/boundary intrinsic internally, so its existing surface is
only partly provider-neutral. MessagePack does not yet use `std::data` as a
general typed format API. The migration must preserve the useful existing
shape, validation, JSON, schema, and MessagePack work while removing that
coupling.

## One compiler-derived plan

For every closed type `T` that is eligible for a DTO, the compiler derives one
`AutoDtoPlan<T>`. This is a compiler artifact, not a public runtime object.
It is the single source of truth for all of the following:

- DTO eligibility and diagnostics;
- `Shape` and its compact field and variant descriptors;
- the schema fingerprint;
- field names and declaration order;
- optional fields;
- arrays, primitive widths, bytes, records, enums, and unions;
- recursive references;
- missing, duplicate, and unknown field rules;
- numeric and range validation;
- structural error paths;
- direct traversal from `T` to a writer;
- direct construction of `T` from a reader; and
- the JavaScript schema emitted for automatic host conversion.

`AutoDtoPlan<T>` is exposed to code generation through `ProgramCodegenView`.
Code generation must consume that view, never the compiler's typing internals.
Format implementations and the JavaScript host consume plan projections only;
they must not independently infer type semantics.

This is an invariant, not an optimization goal. A field name, union tag,
numeric rule, fingerprint, or error path must not vary by the path that reached
the value.

### Canonical shapes and fingerprints

The plan emits a canonical, versioned shape descriptor. Its canonical byte
encoding includes node kinds, primitive widths, bytes, record field names and
declaration order, optionality, union and variant names, recursive references,
and the resolved custom DTO representation. `dtoSchemaAbi` versions this
encoding. The fingerprint is the SHA-256 digest of those canonical bytes.

The fingerprint is a compact identifier and cache key, not independent proof
that unknown bytes have a requested type. A typed frame position already fixes
the expected plan, and the generated reader validates the complete value. When
an incoming or reified schema identity is used to select a plan, the runtime
also compares the canonical descriptor (or a sealed equivalent owned by the
same module/session) before authorizing that selection. A digest match alone
never authorizes a type choice across an untrusted boundary.

### DTO eligibility

Ordinary public structural values are eligible when all reachable data is
eligible. The compiler diagnoses unsupported members at the declaration or
boundary that requires a DTO. Examples include functions, effects, mutable
identity-bearing runtime state, host resources, and borrowed references.

An eligible nominal type keeps nominal meaning in Voyd. Its DTO is a structural
projection, not a claim that unrelated nominal types are interchangeable.

`Bytes` is an eligible primitive. It is not an array of integers and does not
need a custom DTO representation.

## `std::data`

`std::data` owns the provider-neutral structural contract:

```text
std::data
├── Shape and compact field/variant descriptors
├── DecodeOptions, EncodeLimits, DecodeLimits
├── DataReader<SourceError>
├── DataWriter<SinkError>
├── DataValue
├── DataValueReader and DataValueWriter
├── encode<T>     // T -> DataValue
└── decode<T>     // DataValue -> T
```

The exact surface syntax below is conceptual until the data API is introduced.
It specifies required behavior rather than committing to unsupported trait or
associated-type syntax.

### `DataValue`

`DataValue` is the explicit dynamic tree:

```text
Null
Bool
I32
I64
F32
F64
String
Bytes
Array
Object
Variant
```

It is useful for migrations, generic adapters, inspection, tooling, forms,
databases, tests, and simple format implementations. It is never a required
intermediate allocation for JSON, MessagePack, SDK calls, callbacks, or VX.

The familiar explicit tree operations remain:

```voyd
data::encode<T>(value) -> DataValue
data::decode<T>(value, options?: DecodeOptions) -> Result<T, DecodeError>
```

They are defined in terms of the same plan:

```text
T -> generated write<T> -> DataValueWriter -> DataValue
DataValue -> DataValueReader -> generated read<T> -> T
```

`data::decode` validates before constructing the final value. It has no
MessagePack dependency.

### Writers

A `DataWriter<SinkError>` receives one complete data value in order. Its
required operations are conceptually:

```voyd
write_null()
write_bool(value)
write_i32(value)
write_i64(value)
write_f32(value)
write_f64(value)
write_string(value)
write_bytes(value)

begin_array(length:)
end_array()

begin_record(shape:, field_count:)
write_field(field:)
end_record()

begin_variant(union:, variant:)
end_variant()
```

`field`, `union`, and `variant` are compact descriptors from `Shape`. A normal
writer must not require the generated traversal to allocate or repeat a field
string for every record.

Writer calls form a balanced stream. Each `begin_*` has exactly one matching
`end_*`; a scalar fills one expected value; a field label is followed by exactly
one value. The generated traversal owns this sequencing. A writer detects a
provider-side framing error if a caller violates it.

The writer owns its buffer or borrowed output session until it is finished or
aborted. On any error, the session is unusable and must release or return its
resources exactly once. `finish` succeeds only after one complete, balanced
root value. It returns immutable bytes or transfers a buffer according to the
provider's documented ownership rule.

### Readers

A `DataReader<SourceError>` reads one complete data value through a stateful,
pull-based session. Its required capabilities are conceptually:

```voyd
kind()
read_null()
read_bool()
read_i32()
read_i64()
read_f32()
read_f64()
read_string()
read_bytes()

begin_array()
has_next_element()
end_array()

begin_record()
next_field()
skip_value()
end_record()

begin_variant()
end_variant()

finish()
```

`begin_record` starts one record. `next_field` returns the next encoded field
identity, or the end marker. It may return fields in any order. The generated
DTO reader matches each identity to a compact shape descriptor. It owns these
rules:

- Missing required fields are errors after the record ends.
- Duplicate known fields are errors.
- Unknown fields follow the selected `DecodeOptions` policy. The default for
  DTO decoding is reject; an explicit forward-compatible policy skips them.
- `skip_value` consumes exactly one complete value, including nested values.
- A field is considered present only after its complete value is consumed.

`begin_variant` consumes the variant header, enters its payload scope, and
returns the encoded union and variant identity. The generated reader matches
that identity to the expected `Shape` descriptors before it reads the variant
payload. `end_variant` closes the matching scope after the payload is fully
consumed. Unknown or mismatched variant identities are structural errors.

`end_array` succeeds only after `has_next_element` has reported false and no
element value is in progress. `end_record` succeeds only after `next_field` has
reported the end marker and no field value is in progress. Ending either scope
early is a structural framing error; a provider may not silently discard unread
contents.

`finish` succeeds only after one complete, balanced root value has been read,
no value is in progress, and the source is at end-of-input. Generated
`data::read`, typed format decoders, and host-frame decoders call it before
returning a value. It rejects trailing bytes or tokens.

The reader tracks nesting and position. `end_*` calls must match their begin
calls. It must reject malformed nesting, premature end-of-input, trailing bytes
after the root value, and provider-invalid framing. After a source or
structural error, the session is failed and is only eligible for cleanup; it
cannot produce more application values.

`read_null` consumes one null value, exactly as a scalar read consumes one
scalar. Ordinary optional record fields use presence or absence and the plan's
missing-field rule; they do not silently treat a supplied null as an absent
field. A plan accepts null only where its declared DTO representation permits
it, such as `DataValue::Null` or an explicit custom DTO representation.

Readers may know collection lengths early or only at the end. The contract
supports both. Generated code enforces depth and collection limits as it walks;
providers enforce byte and token limits while reading.

### Validation, limits, and errors

The generated DTO reader validates expected kind, optionality, variants,
numeric range, and recursion while consuming the stream. It constructs a typed
value directly; it does not first materialize `DataValue`.

`DecodeOptions` contains only structural choices, such as the explicit
unknown-field policy. `DecodeLimits` and `EncodeLimits` cover depth, collection
length, total bytes, and allocation-related limits. The host supplies safe
boundary defaults; callers of format APIs can choose tighter limits for
untrusted input.

The reader and writer preserve their own generic `SourceError` or `SinkError`.
The data layer wraps it with a structural path when applicable:

```text
DataReadError<SourceError> = Source(SourceError) | Structural { path, kind }
DataWriteError<SinkError> = Sink(SinkError) | Structural { path, kind }
```

`DataReadError` also has `Custom { path, cause: CustomDtoError }` when a custom
DTO representation rejects an otherwise well-formed representation. The exact
public union spelling may differ, but source, structural, custom, and sink
causes must remain available. A host transport maps its provider error into one
normalized ABI failure before crossing the Wasm/SDK boundary. It must preserve
the phase, structural path, and custom error category/code.

### Streaming and adapters

The compiler-generated operations are conceptually:

```text
data::write<T>(value, into: writer)
data::read<T>(from: reader, options: ...)
```

Standard writers and readers stream directly:

```text
T -> AutoDtoPlan write -> MsgPackWriter -> Bytes
Bytes -> MsgPackReader -> AutoDtoPlan read -> T
```

`DataValueWriter` and `DataValueReader` implement the same contract by building
or walking a `DataValue`. They make simple implementations and tests possible
without changing structural semantics.

## Structured format modules

JSON and MessagePack remain format modules with their natural APIs:

```voyd
msgpack::encode(profile) -> Result<Bytes, MsgPackError>
msgpack::decode<Profile>(bytes) -> Result<Profile, MsgPackError>

json::encode(profile) -> Result<String, JsonError>
json::decode<Profile>(source) -> Result<Profile, JsonError>
```

Conceptually, these create their reader or writer and call the generated data
operation. They can also expose parsed `JsonValue` or `MsgPack` APIs for users
who intentionally need format-specific trees.

No public generic `Codec`, `CodecRegistry`, `Encoded<T>`, or
`encoding::encode/decode` exists. Format-to-format conversion can use
`DataValue` deliberately, or a future direct adapter, without changing DTO
rules.

### JSON numeric policy

JSON has one number representation while Voyd distinguishes integer and float
widths. JSON typed decoding validates the expected DTO shape. In particular,
decoding an `i64` from a JSON number rejects values outside JavaScript's exact
integer range, `[-(2^53 - 1), 2^53 - 1]`. JSON typed encoding likewise rejects
an `i64` outside that range. This avoids silent corruption in the normal JSON
and JavaScript ecosystem.

If a future interoperable tagged-integer JSON convention is needed, it must be
a separately versioned format API or explicit application representation. It
must not change the default JSON meaning silently.

### `std::msgpack` cleanup

The current boundary-only MessagePack surface is unreleased. Provider migration
is therefore a clean break, not a compatibility migration. Delete these APIs
and implementation artifacts with no aliases, shims, or replacement names:

- `pack_boundary_value`, `unpack_boundary_value`, and
  `unpack_boundary_value_or_identity`;
- `__boundary_value_to_msgpack`, `__boundary_msgpack_to_value`, and
  `__boundary_msgpack_to_value_or_identity`;
- `boundary_*` compiler-contract helpers and boundary-only array, map, and
  string bridges once selected-provider roles replace them;
- every `@compiler_contract(id: "voyd.std.boundary.msgpack.*")` annotation,
  including annotations currently attached to retained `encode_value`,
  `decode_value`, or `make_*` APIs;
- `@serializer` annotations; and
- boundary-specific documentation and tests.

Migrate or remove std consumers that use `MsgPack` as a generic host envelope,
including HostDto, effect, and VX paths. A host DTO wrapper must use Auto DTO
and the selected module transport instead.

This does not mean deleting useful MessagePack APIs because they happen to
make, inspect, or unpack a MessagePack value. Preserve or rework the `MsgPack`
parsed value tree, explicit value constructors/accessors, and raw value-byte
encode/decode where they remain useful as a format-native API. Add the typed
streaming API alongside them:

```voyd
msgpack::encode<T>(value) -> Result<Bytes, MsgPackError>
msgpack::decode<T>(bytes) -> Result<T, MsgPackError>
```

Audit the whole `std::msgpack` surface during migration. Keep an API only when
it has a current format-native purpose or is an explicit selected-provider role.
Compiler-only bridges do not survive under compatibility names.

## Custom DTO representations

Auto DTO handles ordinary structural types. Exceptional nominal types may need
an explicit, provider-neutral representation: a private-layout identifier, a
domain wrapper, or a validated abstraction with an external record shape.

Introduce one custom DTO representation contract. Its final syntax is to be
designed with the trait system, but its semantics are fixed:

```text
CustomDto<T> chooses one DTO-eligible Representation.

write: T -> Representation
read:  Representation -> Result<T, CustomDtoError>
shape: Shape(Representation)
```

The implementation is singular for `T`; it cannot select a different
representation based on JSON, MessagePack, the SDK, or a call site. The
compiler derives `T`'s shape, fingerprint, recursive behavior, and generated
reader/writer traversal from `Representation`. `read` validates representation
invariants before constructing `T`, and its error is composed with the normal
structural path.

The representation must itself be DTO-eligible and must not reintroduce the
same custom representation through an unguarded cycle. Recursive types use the
normal plan's reference handling. Bytes use the built-in primitive rule and do
not use this contract.

This replaces `@serializer` for the cases where a type's external structure is
not its stored structure. It is deliberately not a wire-format hook.

## Automatic host boundary

The SDK boundary stays automatic and plain:

```text
plain JavaScript value
-> host adapter validates against emitted DTO schema
-> module transport frame
-> Wasm transport reader
-> AutoDtoPlan read
-> Voyd value

Voyd value
-> AutoDtoPlan write
-> Wasm transport frame
-> host adapter decodes and validates
-> plain JavaScript value
```

The fast path does not allocate `DataValue`, a JSON tree, or a MessagePack tree.
Application JSON and MessagePack APIs are separate from this outer transport.

### Host ABI v2

A compiled module has one host transport. It applies to all automatic boundary
routes:

- exported functions and results;
- effect requests and outcomes;
- callbacks and continuations;
- external package calls;
- VX lowered commands, events, tasks, and extensions.

There is no per-export, per-parameter, or per-payload transport override.

ABI v2 defines complete frames, rather than only a value encoder. Required
frame categories are:

- export invocation: positional argument array and export identity;
- export completion: result or normalized failure;
- effect request and outcome;
- callback invocation and completion;
- cancellation and cancellation acknowledgement; and
- VX command/event and extension request/outcome.

Each typed payload position has the relevant emitted schema fingerprint. The
frame version defines field ordering, discriminator rules, and failure shape.
The transport owns encoding those frames; the DTO plan owns the meaning of
their typed payloads.

Frames carry immutable byte buffers. Implementations may borrow Wasm memory,
transfer ownership, share immutable buffers, or use runtime-local handles when
the lifetime is safe. These are optimizations. The observable contract defines
when ownership transfers, when bytes may be released, and that neither side may
mutate a transferred payload.

The host applies byte, depth, and collection limits before allocating
unbounded data. Failures identify direction, frame category, transport phase,
provider error code, and structural path when available. Cancellation reaches
the owner of an outstanding operation; both cancellation and normal completion
obey the capability lifetime rules below.

### Metadata and negotiation

The module emits canonical ABI metadata, conceptually:

```json
{
  "hostAbi": 2,
  "dtoSchemaAbi": 1,
  "transport": {
    "id": "voyd.std.msgpack",
    "version": 1
  },
  "exports": []
}
```

The SDK looks up an adapter by the exact transport ID and version, checks the
host ABI and DTO-schema ABI, and fails during host initialization when no
compatible adapter exists. It must not attempt a best-effort decode with a
different format or version.

The existing JavaScript schema validation remains a projection of
`AutoDtoPlan<T>`. It protects JavaScript conventions such as `number` versus
`bigint`, optional fields, byte buffers, tagged variants, recursive records,
and useful error paths. It cannot become a second source of DTO truth.

## Host transport providers

The compiler must know the selected provider before it generates Wasm wrappers.
An emitted string alone is insufficient: the wrapper needs concrete reader,
writer, and frame entry points to compile and link.

Use a narrow declaration on a stateless provider object. This is conceptual
syntax:

```voyd
@host_transport(
  id: "voyd.std.msgpack",
  version: 1
)
pub obj MsgPackHostTransport

impl HostTransportProvider for MsgPackHostTransport
```

`@host_transport` is the only new identity annotation proposed here. Do not
add broad `@obj(id:)`. A transport identity has compiler and host ABI meaning;
an ordinary object identity should not acquire that meaning accidentally.

`HostTransportProvider` is a compiler-known intrinsic trait with a stable
compiler-contract identity. The attribute supplies the static ID and version;
the trait and provider contract establish that the object is a valid provider.
The marker object is never constructed, passed to user code, or dynamically
trait-dispatched.

The provider contract binds concrete, compiler-validated roles for:

- inbound `DataReader` construction;
- outbound `DataWriter` construction and finalization;
- each ABI v2 envelope/frame operation;
- provider error conversion; and
- buffer ownership and cleanup.

The exact role spelling is intentionally deferred. It may be explicit role
references in the attribute/manifest or fixed static provider members. It must
not depend on guessed method names or ordinary dynamic trait lookup. The
compiler needs exact symbols and signatures to retain and specialize.

### Build-time resolution

The build selects a package, ID, and version. The SDK/compiler resolver loads
that package as a link root, then the compiler:

1. Finds exactly one matching `@host_transport` provider.
2. Validates the intrinsic trait, provider ownership, all role signatures, and
   frame contract.
3. Specializes host wrappers for its concrete reader/writer implementation.
4. Keeps all selected provider symbols reachable.
5. Emits the provider's ID/version with `hostAbi` and `dtoSchemaAbi` metadata.

The JavaScript SDK registers the matching host adapter under the same identity.
It uses emitted metadata to choose that adapter after the module is compiled;
it does not choose the Voyd/Wasm implementation at runtime.

Only `std` and explicitly registered, lockfile-resolved packages may provide a
host transport. This prevents an incidental dependency from shadowing a host
ABI identity.

Within one linked program, `(id, version)` has exactly one provider
declaration. A duplicate is an error, even when declarations look identical.
Different versions of an ID may exist in dependencies, but the build selects
one exact version. Unknown IDs, an unlinked provider package, a wrong package,
a missing role, a duplicate, or a signature mismatch fail before code
generation.

The transport version changes for incompatible wire or frame semantics. The
host ABI and DTO-schema ABI are separate versions; they must not be overloaded
into the transport version. Provider-internal ABI details remain compiler-owned
and are validated at build time rather than exposed as a general application
protocol.

MessagePack can remain the toolchain's initial default transport. The first
public release does not need a public source-level transport-selection API.
The build system may choose the default internally while still using this
provider binding and emitted metadata.

## VX: typed plans, late lowering, and private payloads

VX keeps its public values typed until the final runtime boundary.

`Cmd<Msg>` is an opaque public object. Its constructors and methods are the
only public way to make or combine commands. Internally it stores a typed
semantic plan, not a wire tree:

```text
Cmd<Msg> -> CommandPlan<Msg> -> final lowering -> CommandWire -> host frame
```

Conceptually:

```text
CommandPlan<Msg>
  None
  Message { value: Msg }
  Batch { children: Array<CommandPlan<Msg>> }
  Delay { millis: i64, value: Msg }
  Map { private existential plan }
  Task { private existential plan }
  Host { typed built-in request }
  Extension { private existential plan }
```

`Batch` remains ordinary same-`Msg` recursion. `Map`, `Task`, and `Extension`
hide a type only where it genuinely cannot be expressed in the public generic
type. Construction captures the typed child, its DTO plan/fingerprint, and its
handler. Final lowering performs the erasure once.

The private non-generic wire tree retains structure that the host must inspect:

```text
CommandWire
  None
  Message { payload: EncodedPayload }
  Batch { children: Array<CommandWire> }
  Delay { millis: i64, payload: EncodedPayload }
  Map { child: CommandWire, handler: HandlerRef }
  Task { task: TaskRef, handler: HandlerRef }
  Host { request: HostCommandWire }
  Extension { extension: ExtensionRef, request: EncodedPayload, handler?: HandlerRef }
```

`EncodedPayload` is a private runtime carrier, not a public type. At final
lowering, every `Message` and `Delay` payload becomes one because the
non-generic `CommandWire` no longer knows `Msg`. Mapped messages, task results,
and extension payloads additionally erase their input/result types and carry
handler expectations. The carrier contains immutable bytes and the expected DTO
schema fingerprint. It inherits the module transport, so it does not need a
separate format identity unless a future multi-transport runtime makes one
necessary. Before a handler receives it, the runtime obtains the expected plan
from its sealed handler/capability record, checks the fingerprint as an index,
and validates/decodes it with that plan and the module transport. The
fingerprint alone never selects a handler type.

Do not make a mapped child an encoded whole `CommandWire`. The host would then
have to parse it again to discover batches, delays, tasks, and nested commands.
Keeping `CommandWire` structural avoids nested dispatch and preserves the data
the host needs to execute.

Built-in `HostCommandWire` is a closed, typed, versioned union. Its ordinary
request fields use Auto DTO. Typed extensions remain supported, but they reuse
the existing versioned external/effect interface identity. They do not create a
second raw string command registry.

### Capability lifetime

`HandlerRef`, `TaskRef`, and `ExtensionRef` are scoped capability tokens, not
portable DTO data. Each carries a runtime session, a generation, and the shape
needed for resolution. The registry validates all three.

A token's operation has one terminal outcome: normal completion, failure, or
cancellation. It is one-shot unless a specific subscription contract states
otherwise. The owner releases its lease exactly once on that terminal outcome.
Generation checks reject replay and stale messages; cancellation races resolve
to one recorded terminal outcome. The host cannot invent a valid token by
guessing its scalar transport representation.

### Other VX values

The same direction applies to the remaining former boundary users:

- `Program` becomes typed application descriptors and typed transitions, then
  lowers at the host boundary.
- `Sub` uses a typed semantic plan and final lowering like `Cmd`.
- `Html<Msg>` and `Attr<Msg>` become opaque typed builder IR with explicit
  lowering, not encoded aliases.
- Canvas values become ordinary semantic objects and unions; only final canvas
  requests enter the closed host wire union.

This is required for complete `@boundary` removal, not optional VX cleanup.

## Attribute removal and migration

This is a breaking change. `@boundary` and `@serializer` are removed without a
compatibility API, deprecated parser path, or legacy raw wrapper.

`@boundary` is replaced by automatic DTO host conversion and explicit semantic
plan-to-wire lowering. `@serializer` is replaced by Auto DTO or the custom DTO
representation contract.

Completion requires removal from all of the following:

- parser syntax macros and surface attributes;
- binding, semantic metadata, and symbol indexes;
- compiler intrinsics, code generation, and optimization/reachability logic;
- MessagePack-specific boundary traversal and hard-coded export ABI format IDs;
- std declarations, helper wrappers, and VX APIs;
- SDK host imports and raw MessagePack transport assumptions;
- tests, fixtures, snapshots, and test inventory entries; and
- user-facing reference, architecture, and normative specification documents.

The language reference must document DTO eligibility, shapes, custom DTOs,
format APIs, host-boundary behavior, transport compatibility failures, and VX
typed lowering. Update every normative document that prescribes the old model.
Historical proposals may remain unchanged only when clearly marked as
superseded and linked to this proposal; do not silently rewrite history.

## Compiler and host decoupling is a hard requirement

Provider migration is incomplete if the old MessagePack-specific compiler path
remains as a dead path, fallback, or hidden special case. After migration,
generic compiler boundary code may know only `AutoDtoPlan`, its
`ProgramCodegenView` projection, and the selected host-provider contracts.
MessagePack knowledge may remain only in the std MessagePack provider and its
matching JavaScript default adapter.

Current migration targets include:

- direct boundary MessagePack traversal in
  `packages/compiler/src/codegen/boundary/msgpack-codec.ts`;
- host-boundary MessagePack helper/loading and request/resume modules;
- hard-coded serialized-export `formatId: "msgpack"` values;
- the global `BOUNDARY_MSGPACK` compiler-contract catalog and bootstrap;
- serializer and boundary special cases and intrinsics; and
- generic external, effect, and export code that imports or calls those paths.

These are roles to migrate, not files to preserve under new names. Replace them
with selected-provider operations, then delete obsolete files, contracts,
bootstrap code, fixtures, and tests. Convert useful coverage into
provider-neutral tests or provider-specific tests that live with the MessagePack
provider.

`std::data` must have no MessagePack import or MessagePack/boundary intrinsic
route. Generic `js-host` core must have no direct MessagePack dependency; the
matching host adapter may depend on MessagePack. Compiler core must likewise
have no format-specific imports outside the selected provider implementation.

Enforce this architecture with tests or an import-boundary check that fails if
generic compiler boundary code or generic `js-host` core imports a
format-specific module. Keep narrowly named allow-lists for the std MessagePack
provider and its JavaScript adapter only. The check must also reject revived
`formatId: "msgpack"` branches in generic ABI code.

## Performance requirements

The standard JSON, MessagePack, SDK, and VX paths must:

- stream directly between typed values and bytes;
- allocate `DataValue` and format-specific trees only when explicitly asked;
- specialize selected reader/writer calls at compile time;
- avoid per-field dynamic dispatch;
- use compact shape descriptors rather than repeated field strings;
- construct typed values directly from readers;
- preserve or transfer immutable byte buffers without copying when ownership
  permits; and
- enforce byte, depth, allocation, and collection limits.

Before replacing the boundary implementation, benchmark and set acceptance
gates for large arrays and byte buffers, deep records, variant-heavy values,
VX command batches, frequent event messages, JSON throughput, MessagePack
throughput, allocation count, and peak memory. A new architecture that relies
on optimizer fusion to remove a mandatory tree is not acceptable.

## Delivery sequence

1. Inventory and preserve the existing shape, `DataValue`, JSON, boundary
   schema, JavaScript validation, and MessagePack behavior that this proposal
   migrates.
2. Define DTO eligibility, `AutoDtoPlan`, `Shape`, fingerprints, and the
   `ProgramCodegenView` contract. Establish the plan as the sole source for
   current boundary schema derivation.
3. Add `std::data`: shapes, limits/options/errors, reader/writer semantics,
   `Bytes` in `DataValue`, `data::encode`, and reader/writer adapters. Replace
   the current `DataValue -> MessagePack -> T` conversion with direct plan
   traversal and remove `std::data`'s MessagePack import/intrinsic route.
4. Implement MessagePack reader/writer behind the data contract and preserve
   behavior with direct streaming benchmarks. Add typed `msgpack::encode` and
   `msgpack::decode`, then audit `std::msgpack`: retain only format-native
   parsed-tree APIs and selected-provider roles; delete all boundary bridges,
   `@serializer` annotations, boundary docs/tests, and HostDto/effect/VX uses
   of `MsgPack` as a generic host envelope. Add JSON reader/writer and typed
   APIs, including the explicit JSON `i64` policy.
5. Define and implement the custom DTO representation contract. Migrate every
   current non-ordinary serializer use to Auto DTO or that contract.
6. Define ABI v2 frames and the compiler-known host transport provider
   contract. Convert the current MessagePack implementation into the first
   selected provider; add emitted metadata and SDK adapter negotiation.
7. Migrate exports, effects, callbacks, and external package calls to the one
   selected provider. Delete the legacy compiler contracts, traversal,
   hard-coded format IDs, and generic host MessagePack dependency; add the
   import-boundary enforcement.
8. Migrate VX to opaque typed plans, final `CommandWire` lowering, private
   `EncodedPayload`, closed host commands, and scoped capability lifecycle.
   Apply the same model to `Program`, `Sub`, `Html`, `Attr`, and Canvas.
9. Remove `@boundary`, `@serializer`, obsolete intrinsics, raw VX APIs, legacy
   tests, fixtures, and documentation in the same breaking change.
10. Run acceptance tests and performance gates across compiler, std, SDK, host,
    VX, and reference documentation before merge.

## Acceptance criteria

- Every eligible type has one DTO plan and all shape/schema/reader/writer
  projections agree with it.
- Typed JSON, MessagePack, `DataValue`, and SDK conversion do not route through
  a MessagePack-specific compiler path.
- `std::data` has no MessagePack import or MessagePack/boundary intrinsic
  route, and MessagePack uses the data contract as a provider rather than a
  compiler special case.
- `std::msgpack` and its tests contain no boundary-named API, boundary
  intrinsic, `voyd.std.boundary.msgpack.*` compiler-contract annotation,
  compatibility bridge, `@serializer` annotation, or generic host DTO
  envelope. Its remaining APIs have a current format-native or selected
  provider role.
- Generic compiler boundary code and generic `js-host` core have no
  format-specific imports, helpers, hard-coded format IDs, or fallback paths;
  the import-boundary check enforces this. Only the selected provider and its
  matching adapter may know MessagePack.
- Normal SDK calls still exchange plain JavaScript values without application
  encoding calls.
- A module uses one negotiated transport for every automatic boundary route.
- A missing or incompatible host adapter fails before user code executes.
- VX commands preserve structure until final lowering and use erased payloads
  only at true existential boundaries.
- Capability tokens cannot be replayed across sessions or terminal outcomes.
- No parser, metadata, codegen, std, SDK, test, or reference surface supports
  `@boundary`, `@serializer`, raw VX MessagePack payloads, or the former public
  encoding design.
- Direct streaming paths meet the agreed benchmark gates without relying on
  optimizer fusion to remove required intermediate trees.

## Open decisions

- Choose the final source syntax for provider role binding: explicit manifest
  references or compiler-validated static provider members.
- Choose the exact public spelling of generic data errors and reader/writer
  lifetime/ownership APIs after validating it against Voyd's trait system.
- Decide whether the first release permits non-std registered transport
  providers or only std-owned providers.
- Specify a subscription exception, if any, to the default one-shot capability
  lifetime rule.
