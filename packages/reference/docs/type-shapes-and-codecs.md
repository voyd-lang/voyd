---
order: 205
---

# Type Shapes and Structural Codecs

`std::meta::shape_of<T>()` reifies a closed Voyd type as a provider-neutral
`Shape` value. A shape describes Voyd data directly; it does not expose
compiler type IDs and does not depend on JSON Schema, MessagePack, or another
wire-format vocabulary.

```voyd
use std::meta::{ RecordShape, shape_of }

obj Profile {
  /// Display name shown to other users.
  name: String,
  nickname?: String
}

let shape = shape_of<Profile>()
shape.root.match(node)
  RecordShape:
    // node.fields preserves declaration order, optionality, and documentation.
    node.fields
```

## Shape model

`Shape::root` is a `ShapeNode`. Nodes cover boundary-compatible primitives,
arrays, records, named unions, and references. Recursive types use `RefShape`
entries whose graph-local keys resolve through `Shape::definitions`; compiler
IDs never appear in the graph. Definition names remain available separately for
display. Keys are deterministically disambiguated when distinct imported or
generic types have the same source-level name. A key is meaningful only within
the `Shape` value that contains it and should not be persisted independently.

Record fields and union variants preserve declaration order. Documentation is
available when a declaration or field has a doc comment. Missing comments are
represented as `None` rather than synthesized text.

Nominal records use their declaring object name and documentation. When an
erased union has several aliases, Shape chooses the alias lexicographically by
name and takes documentation from that same declaration. Alias display names
are descriptive metadata rather than persistent identity; use graph-local keys
to resolve references.

The public names and meanings in `std::meta` are intended as stable standard
library API. Consumers should still handle newly added `ShapeNode` variants
when upgrading Voyd, because the supported boundary type set may expand.

## Typed MessagePack codecs

`std::msgpack::encode` and `decode` apply the compiler-derived DTO plan for the
closed Voyd type at the call site. They support the same primitives, arrays,
records, optional fields, and named union or enum payloads as `shape_of<T>()`.

```voyd
use std::array::Array
use std::enums::{ enum }
use std::msgpack::{ encode, decode }
use std::string::type::String

enum Event
  Created { id: i32, labels: Array<String> }
  Deleted { reason: String }

type EnvelopeV1 = {
  version: i32,
  requestId: String,
  event: Event
}

let encoded = encode<EnvelopeV1>({
  version: 1,
  requestId: "request-7",
  event: Event::Created { id: 42, labels: ["host"] }
})
let decoded = match(encoded)
  Ok { value: bytes }:
    decode<EnvelopeV1>(bytes)
  Err { error }:
    Err { error }
```

The wire schema is deliberate and inspectable:

- Record keys are the exact declared field names and are emitted in declaration
  order. A field rename is therefore a wire-schema change.
- Missing optional fields are omitted. Present values use the field's normal
  representation.
- Named variants are maps whose `$variant` value is the declared variant name;
  payload fields are siblings of that discriminator.
- Versioning is explicit. Add a normal `version` field to a versioned DTO and
  dispatch or migrate it in application code. The codec does not inject a
  version or perform migrations.

The parsed `MsgPack` tree remains available for format-specific tooling.
`from_data_value` and `to_data_value` convert explicitly between it and the
provider-neutral `DataValue` tree; ordinary typed encoding does not use the
parsed tree API.

Exceptional nominal types declare one provider-neutral wire representation by
implementing `CustomDto<T, Representation>`. The same representation is used
by every codec and host boundary.

Unsupported shapes and ambiguous variant payloads fail at compile time at the
codec call. In particular, variant payload fields cannot be named `tag` or
`$variant`, because those names conflict with boundary discriminators.

## Fallible decoding

Wire-format or configuration providers can translate their own dynamic value
model into `std::data::DataValue`, then use `decode<T>` for checked structural
conversion.

```voyd
use std::array::Array
use std::data::{ DataField, DataI32, DataObject, DecodeError, decode }
use std::result::types::all

obj Request { count: i32 }

let ~fields = Array<DataField>::init()
fields.push(DataField { name: "count", value: DataI32 { value: 3 } })

match(decode<Request>(DataObject { fields }))
  Ok<Request> { value }:
    value.count
  Err<DecodeError> { error }:
    // error.kind and error.path are safe to report or map into provider errors.
    0
```

Decoding validates the complete value before constructing `T`. Failures are
returned as `DecodeError` values with a stable category and a rooted path such
as `$.profile.age` or `$.items[2]`. Errors distinguish missing fields, unknown
fields, duplicate fields, wrong value kinds, invalid union variants, and invalid shape
references.

Unknown fields are rejected by default. Pass `DecodeOptions` with
`IgnoreUnknownFields {}` to accept them. This policy applies consistently to
records and union payloads at every nesting level.

## Supported types and limitations

Shapes and codecs use the same boundary-compatible type rules as typed host
boundaries:

- `bool`, `i32`, `i64`, `f32`, `f64`, `String`, and unit
- `Array<T>` when `T` is supported
- records and objects whose non-private fields are supported
- named unions and variants whose payload fields are supported
- aliases, imported types, optional fields, and recursive references composed
  from the categories above

Unsupported inputs, including functions, traits, unresolved type parameters,
and implementation-oriented containers such as `Dict`, produce a compile-time
diagnostic at `shape_of<T>()`. This is intentional: generated structural codecs
only operate on closed types with deterministic boundary representations.

`shape_of<void>()` is supported and produces `UnitShape`, matching a boundary
function's unit result. `decode<T>` accepts the value-bearing subset of the
categories above; `void` is not a valid decoder target because `Result<T, E>`
requires a concrete success payload. Providers should model an explicit unit
value with a record or named variant when it must appear in dynamic data.

`DataValue` is an interchange model, not a general reflection or mutation API.
It does not preserve object identity, arbitrary runtime values, private state,
or provider-specific number and metadata extensions. Providers remain
responsible for mapping their own syntax and range rules into the exact
`DataValue` kinds expected by the target shape.
