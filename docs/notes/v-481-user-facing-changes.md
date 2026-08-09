# V-481 user-facing changes

This document catalogues the user-visible changes between `main` and
`drew/v-481-harden-voyd-across-the-full-stack-voyd-orbit-findings`. It
supplements the ticket-oriented
[V-481 API design report](./v-481-api-design-report.md) with a surface-oriented
account of the complete branch diff. Signatures and examples below were checked
against the implementation, tests, and reference documentation on that branch.

The scope includes the Voyd language and diagnostics, the standard library,
the Web package, the JavaScript host and SDK, VX browser/server rendering and
Canvas, the CLI and language server, and the Voyd Orbit example application.
Internal refactors are omitted unless they change an observable contract or an
importable low-level package export.

## Table of contents

- [Migration and breaking-change summary](#migration-and-breaking-change-summary)
- [Language semantics and compiler behavior](#language-semantics-and-compiler-behavior)
  - [Single evaluation and execution order](#single-evaluation-and-execution-order)
  - [Multiline expressions and constructor calls](#multiline-expressions-and-constructor-calls)
  - [Hygienic macros and generated declarations](#hygienic-macros-and-generated-declarations)
  - [Effects and operation identity](#effects-and-operation-identity)
  - [Modules, nested packages, re-exports, and visibility](#modules-nested-packages-re-exports-and-visibility)
  - [Compiler diagnostics and recovery](#compiler-diagnostics-and-recovery)
- [Standard library](#standard-library)
  - [Derived MessagePack boundary codecs](#derived-messagepack-boundary-codecs)
  - [Strict typed JSON](#strict-typed-json)
  - [Filesystem operations and portable I/O errors](#filesystem-operations-and-portable-io-errors)
  - [RFC 3339 UTC timestamps](#rfc-3339-utc-timestamps)
  - [Locale-independent number formatting](#locale-independent-number-formatting)
  - [Secure bytes and UUIDs](#secure-bytes-and-uuids)
  - [Approximate numeric test assertions](#approximate-numeric-test-assertions)
- [Web framework](#web-framework)
- [VX markup, DOM, events, and Canvas](#vx-markup-dom-events-and-canvas)
  - [Tag-aware JSX form values](#tag-aware-jsx-form-values)
  - [Canvas v2 types and calls](#canvas-v2-types-and-calls)
  - [Canvas host validation and rendering](#canvas-host-validation-and-rendering)
  - [Pointer cancellation and capture](#pointer-cancellation-and-capture)
- [JavaScript host and SDK](#javascript-host-and-sdk)
- [CLI and language-server behavior](#cli-and-language-server-behavior)
- [Voyd Orbit workflow and wire behavior](#voyd-orbit-workflow-and-wire-behavior)
- [Low-level TypeScript package exports](#low-level-typescript-package-exports)
- [Migration checklist and further reading](#migration-checklist-and-further-reading)

## Migration and breaking-change summary

The branch is largely additive, but the following changes require deliberate
migration.

| Surface | Breaking or stricter change | Migration |
| --- | --- | --- |
| Effects | Operation names must be unique within an effect. Effect operations are no longer overloads or first-class values, and qualified lookup no longer falls back to ordinary functions. | Rename same-named operations, call them through their declaring effect, and replace stored operation designators with ordinary wrapper functions. |
| Closed effect handlers | `std::fs::Fs` adds `write_atomic` and `create_exclusive`; `std::test::assertions::Test` adds `fail_with`. | Add clauses to exhaustive handlers, even if they only return an unsupported-operation fixture. |
| I/O errors | `IoError` gains the required public field `kind: IoErrorKind`. | Add `kind`, normally `IoOther {}`, to hand-constructed values and update exhaustive matches. |
| Derived structural shapes | Duplicate union discriminator names and other unsupported or ambiguous shapes fail compilation through the shared shape derivation used by `shape_of`, typed MessagePack, typed JSON, and Web query extraction. MessagePack field and variant spelling is now an explicit wire contract. | Give every union variant a distinct declared name, remove unsupported functions/private fields from DTOs, avoid `tag`/`$variant` variant payload fields, and version intentional wire renames. |
| JSON decoding | New `decode<T>` is strict by default and rejects unknown fields. | Use `permissive_decode_options()` only where forward-compatible unknown fields are intentional. Existing `parse` and `stringify` remain available. |
| Modules/packages | `foo.voyd` and `foo/pkg.voyd` cannot both claim logical module `foo`. Nested package internals are hidden across the package boundary. | Keep the ordinary file as the facade or replace it with the nested package; re-export external API from `pkg.voyd`. |
| Web package | The legacy child module physically represented by `src/all.voyd` is no longer re-exported, and the public route-DSL `serve` macro is owned by the Web package root. | Import `serve` from `pkg::web` directly or through the still-valid `use pkg::web::all` root selection; do not import the route-DSL macro from `pkg::web::router`. |
| VX Canvas | `canvas_frame` now emits wire version 2. `CanvasPathSegment`, `CanvasDraw`, and `CanvasRadialGradient` cannot be constructed externally with raw object literals because they contain private typed caches. | Build values with the public constructors. Hosts that accept frames must accept v2 for the expanded grammar; the bundled host still reads legacy v1 frames. |
| VX events | Voyd `MouseEvent` and TypeScript `MouseEventPayload` gain required `pointer_id`; TypeScript `EventOptions` gains `pointerCapture?`. | Add `pointer_id` when constructing or destructuring event fixtures. Non-pointer mouse, wheel, and drag events use `0`. |
| Host adapters | A custom `randomBytes` hook must return a `Uint8Array` of exactly the requested length. `NodeFsPromises.writeFile` must permit an optional `{ flag?: string }`. | Update mocks and adapters; do not return oversized entropy buffers expecting truncation. |
| Orbit | Persisted simulation IDs become canonical lowercase UUIDs, and four JSON readers now return `JsonDecodeError` instead of `JsonError`. | Rename stored files/IDs if preserving old data, and update result matches to the new error type. Existing v1 camel-case JSON fields are preserved. |

There are also newly enforced failures that may expose previously accepted bad
programs: ambiguous module paths, duplicate effect operations, non-`api`
cross-package members, imported operators or trait implementations omitted from
the import selection, bare effect-operation values, invalid JSX property/tag
pairs, and invalid generic type-argument counts.

## Language semantics and compiler behavior

### Single evaluation and execution order

Each dynamic source-expression occurrence is now observationally evaluated once
after macro expansion. Type tests, coercions, structural and tuple projections,
pattern checks, field loads, and runtime identity guards reuse a stabilized
result. Writing the expression twice still evaluates it twice.

```voyd
fn next_pair() -> { left: i32, right: i32 }
  // This could allocate, mutate state, trap, or perform effects.
  produce_pair()

let pair = next_pair()
let total = pair.left + pair.right
```

Compiler-generated projections now behave like the explicit binding above.
This is observable for allocation identity, fresh closures, mutation, traps,
divergence, and effects; an empty inferred effect row is not permission to run a
source expression again.

Evaluation order is also preserved while values are stabilized. Tuple operands
are evaluated left to right, and setup for a later operand is not run after an
earlier operand traps. Optimizations may rematerialize only with a proof of
observational equivalence and may not move setup across control flow, effect
handlers or suspension, argument/default ordering, borrow activation, or
runtime guards.

Macro authors must still avoid emitting the same splice more than once. Bind a
splice once and reuse its generated binding:

```voyd
pub macro '??'(left, right)
  let item = identifier("__optional_left")
  `(let $item = $left
    if $item is Some:
      $item.value
    else:
      $right)
```

The standard `??`, `?.`, `for`, enum expansion, inline-union extraction, and
VX retained-callback paths were hardened around this rule.

### Multiline expressions and constructor calls

An operator at the end of a line continues the expression onto an indented
right-hand side. The indentation no longer turns the right-hand side into a
call-shaped child block.

```voyd
let total = subtotal +
  tax +
  shipping

let eligible = is_active and
  has_capacity
```

A trailing `:` still opens a suite. Put the continuation operator on the
preceding line when splitting an expression.

Type-call constructor sugar remains supported when it matches an `init`
initializer. When the arguments do not match, `TY0008` or `TY0021` now points at
the type spelling and recommends the explicit call:

```voyd
// Sugar, when the initializer matches.
let point = Point(10.0, 20.0)

// The diagnostic suggests this form when the sugar is ambiguous or mismatched.
let point = Point::init(10.0, 20.0)
```

### Hygienic macros and generated declarations

Macro syntax now carries an internal lexical identity independent of displayed
spelling:

- caller syntax and splices retain call-site identity;
- literal identifiers in a template use the macro-definition context;
- each `identifier(...)` call creates a fresh deterministic identity;
- a macro must reuse the same returned syntax object for a declaration and all
  references to that declaration.

The callable macro-expander forms are:

```voyd
identifier("debug_name")       // fresh identifier with this readable spelling
identifier(existing_name)     // fresh identifier; copies spelling, not identity
symbol_reference(helper)      // exact definition-site symbol
symbol_reference(module::item)
```

`symbol_reference` accepts identifier or qualified-symbol syntax. It does not
accept a string, cannot be used as a declaration name, and never falls back to
a same-named caller declaration. It can reference an existing value, type,
trait, or effect. Private cross-module references become hidden implementation
and link dependencies without exposing the target as public API.

```voyd
fn private_helper(value: i32) -> i32
  value + 1

pub macro increment(value)
  let helper = symbol_reference(private_helper)
  `($helper $value)
```

Fresh generated declarations remain private even inside a public expansion. A
fresh alias in grouped `pub use` downgrades that import to module visibility; a
public trait or effect with a fresh generated member is similarly kept
module-visible. There is no raw or unhygienic capture escape.

The standard `enum` macro now gives each generated variant a private fresh
identity and separately exposes the natural variant spelling through the enum
namespace. Different enums can therefore reuse variant names without a module
collision. Compiler-inserted JSX helpers and empty-child array types also bind
directly to their standard-library identities, so caller declarations named
`value`, `checked`, `disabled`, `class`, `attr`, `Array`, or `HtmlNode` cannot
shadow the generated helper.

Lexical identity and macro provenance are compilation-only: they are omitted
from AST JSON, public metadata, and Wasm names. A diagnostic originating in
generated syntax uses the invocation as its primary location and can attach the
macro definition as related context. Language-server navigation and rename use
the visible definition syntax while retaining a distinct identity per
invocation.

See [Macros](../../packages/reference/docs/macros.md) for the full hygiene
model.

### Effects and operation identity

An effect operation is identified by its declaring effect and declaration
symbol. Aliases, calls, handler clauses, imports, re-exports, effect rows, hover,
rename, and code generation preserve that identity. Same-spelled operations in
different effects remain distinct.

Operation names must be unique inside one effect. Effect operations no longer
form overload sets:

```voyd
@effect(id: "example.metrics")
eff Metrics
  info_count(tail, value: i32) -> void
  info_ratio(tail, value: f64) -> void
```

`Metrics::info_count(...)` resolves `Metrics` first and then searches only that
effect's operation table. A module qualifier searches only ordinary module
exports. Missing operations do not fall back to lexical functions, static
methods, trait methods, general overloads, or same-named wrappers.

Effect operations are not first-class values:

```voyd
let operation = Metrics::info_count // BD0009
Metrics::info_count(3)              // valid call
```

A designator is valid only as a call target, handler head, explicit import or
re-export target, or tooling target. Handler qualifiers must resolve to an
effect, the named operation must exist, and the first handler binder must match
the declaration's `tail` or `resume` mode. An ordinary function cannot be used
as an effect handler merely because its name matches.

Explicit unqualified selection remains available:

```voyd
use Metrics::info_count
use Metrics::info_ratio as record_ratio
use Metrics::all
```

If an imported operation collides with an ordinary function, the compiler asks
for `Effect::operation(...)` or an alias instead of merging them. Conversely,
`module::all` excludes effect operations. An explicitly re-exported operation
can later be explicitly selected as an unqualified name, but it does not become
a valid `facade::operation(...)` member.

Composable handlers keep the existing typed policy: an inner `try open` may
override selected operations and forward the rest to an exhaustive outer
handler. No fallback-clause syntax or erased dynamic continuation was added.
Reusable policies should remain ordinary `with_*` functions.

Two standard effects gain operations in this branch:

```voyd
// std::fs::Fs
write_atomic(tail, payload: MsgPack) -> MsgPack
create_exclusive(tail, payload: MsgPack) -> MsgPack

// std::test::assertions::Test
fail_with(resume, pointer: i32, byte_len: i32) -> void
```

All exhaustive handlers of those effects must add matching clauses.

See [Effects](../../packages/reference/docs/types/effects.md) for resolution,
selection, and handler rules.

### Modules, nested packages, re-exports, and visibility

`src/foo.voyd` and `src/foo/pkg.voyd` now conflict because both claim the
logical module path `src::foo`. `MD0006` names both files and chooses neither.
This check applies while resolving entries, ancestors, and descendants.

```text
src/
  foo.voyd       # choose this facade ...
  foo/pkg.voyd   # ... or this nested package root, not both
```

A nested package root is still physically named `pkg.voyd` but imported by its
logical directory path:

```voyd
// src/simulation/pkg.voyd
use src::simulation::default_scenario
```

Its parent package is an external consumer. Within an ordinary module, `pub`
means package-visible; at a package root, public declarations and re-exports
form the external surface. `pri` remains owner-only. Cross-package field or
method access requires `api` on an exported owner, and cross-package object
construction requires all directly initialized fields to be `api` or a public
constructor to hide them.

`module::all` is a one-level selection. It includes exported values, functions
and overloads, types, traits, effects, macros, and top-level operators. It does
not recursively flatten child modules, expose instance members as free names,
or include effect operations. Operators must be explicitly selected or brought
in by `all`; an `api` operator in an `impl` follows its exported owner.

Package-root re-exports now preserve overload sets, macro expansion metadata,
top-level operators, trait implementations, effect metadata, nominal identity,
and generic match-pattern specialization. This fixes several previously visible
failures: imported generic match patterns specialize independently for each
caller type; private enum variants remain usable inside imported patterns; and
re-exported traits/operators continue to participate in method and operator
resolution.

The low-level module resolver keeps its existing callable signature:

```ts
resolveModuleFile(
  path: ModulePath,
  roots: ModuleRoots,
  host: ModuleHost,
): Promise<ResolvedModuleFile | undefined>
```

It can now reject with:

```ts
class AmbiguousModulePathError extends Error {
  readonly modulePath: ModulePath;
  readonly ordinaryFile: string;
  readonly packageRootFile: string;

  constructor(args: {
    modulePath: ModulePath;
    ordinaryFile: string;
    packageRootFile: string;
  });
}
```

`compileProgram` converts that exception into `MD0006` with related locations;
direct users of `@voyd-lang/compiler/modules/path.js` should catch it.

See [Modules](../../packages/reference/docs/modules.md) and
[Visibility](../../packages/reference/docs/visibility.md).

### Compiler diagnostics and recovery

New codes and materially changed messages are:

| Code | Observable cases |
| --- | --- |
| `BD0008` | An unresolved `symbol_reference` target, with the macro-definition location as related context. |
| `BD0009` | Duplicate or missing effect operation, non-effect handler qualifier, ordinary function used as a handler, or first-class effect-operation designator. |
| `MD0006` | An ordinary module and nested `pkg.voyd` claim the same logical path; both files are related locations. |
| `BD0001` | More precise module-private, package-private, hidden nested-package, unexported macro, instance-member import, package-root re-export, and effect-operation import-collision guidance. |
| `TY0008`, `TY0021` | Mismatched constructor sugar identifies and recommends `Type::init(...)`. |
| `TY0009`, `TY0010` | Cross-package members and construction fields explicitly require `api`. |
| `TY0022` | Names an available but omitted operator import or trait-implementation import and its facade file. |
| `TY0049`, `TY0052` | Escaping-borrow hints recommend owned snapshots, immutable fixtures, or `SharedCell<T>`, with `with`/`with_mut` completed before `tail` or `resume`. |
| `CG0001` | Derived boundary-codec failure at the codec call, including the nested unsupported/ambiguous field or variant path. |

Error recovery now preserves more independent diagnostics from one build. The
pipeline can report multiple bad modules and multiple undefined names in the
same function instead of stopping at the first. Missing returns use `TY0034`,
missing object fields use `TY0037`, and invalid spreads use `TY0027` instead of
falling through to `TY9999`. The root compiler API shape is unchanged; callers
receive a more complete and more specific `diagnostics` array.

Explicit generic type arguments are now validated against the declared count,
including excess and unresolved arguments. These failures currently enter the
public module-analysis result through the unexpected-error fallback and use
`TY9999`; consumers should match the message until a dedicated stable code is
introduced.

## Standard library

### Derived MessagePack boundary codecs

The existing shape-reification calls in `std::meta` are:

```voyd
pub fn shape_of<T>() -> Shape
pub fn try_shape_of<T>() -> Option<Shape>
```

Their signatures do not change, but the shared derived-schema validation is
stricter. Every named union variant must have a unique declared name because
that name is the `$variant` discriminator used by structural consumers.
`shape_of<T>()` produces a compile diagnostic for duplicate discriminators;
`try_shape_of<T>()` returns `None`. The same restriction applies when typed
MessagePack, typed JSON, or Web query extraction derives the shape.

```voyd
use std::meta::{ Shape, shape_of }

obj Added<T> { value: T }
type Change = Added<i32> | Added<String> // both variants are named "Added"

let schema: Shape = shape_of<Change>() // compile-time duplicate discriminator error
```

Give the variants distinct nominal names when they belong to one union.

The existing calls in `std::msgpack` now use compiler-derived typed codecs:

```voyd
pub fn pack_boundary_value<T>(value: T): () -> MsgPack
pub fn unpack_boundary_value<T>(value: MsgPack): () -> T
```

Supported closed shapes are `bool`, `i32`, `i64`, `f32`, `f64`, `void`,
`String`, `Array<T>`, structural or nominal records/objects whose serialized
fields are boundary-compatible and visible, optional fields, and named
enum/union variants. Recursive references are followed through the closed shape
graph.

```voyd
use std::msgpack::{ pack_boundary_value, unpack_boundary_value }

obj Profile {
  name: String,
  nickname?: String
}

let wire = pack_boundary_value(Profile { name: "Ada" })
let decoded = unpack_boundary_value<Profile>(wire)
```

Wire rules are explicit:

- record keys use exact source spelling;
- arrays retain order;
- absent optional fields are omitted;
- record encoding follows declaration order for determinism, but MessagePack
  maps are semantically unordered and key order is not a compatibility promise;
- a named variant is a map with `$variant` set to its declared name and payload
  fields as siblings;
- a variant payload field named `tag` or `$variant` is rejected;
- union variants with the same discriminator spelling are rejected, including
  different instantiations of the same generic nominal type.

Unsupported functions, traits, private/non-boundary fields, unresolved shapes,
and ambiguous variants produce `CG0001` at the `pack_boundary_value` or
`unpack_boundary_value` call with a nested path. Decoding a wrong runtime shape
uses the strict generated decoder and panics rather than silently manufacturing
defaults. Existing untyped MessagePack unpacking functions retain their own
behavior.

Renaming a serialized field or variant is a wire-breaking change. The compiler
does not inject versions or migrations; add an ordinary `version` field and own
the migration policy in the application. Values wrapped with
`@boundary(type: "payload", field: "payload")` keep their envelope contract.

See [Type shapes and codecs](../../packages/reference/docs/type-shapes-and-codecs.md).

### Strict typed JSON

`std::json` adds the following public types:

```voyd
pub obj JsonParseFailure {}
pub obj JsonSchemaFailure {}
pub obj JsonVersionFailure {}
pub obj JsonConstraintFailure {}

pub type JsonDecodeErrorKind = JsonParseFailure
  | JsonSchemaFailure
  | JsonVersionFailure
  | JsonConstraintFailure

pub obj JsonDecodeError {
  api kind: JsonDecodeErrorKind,
  api path: String,
  api message: String
}

pub obj JsonDecodeOptions {
  api unknown_fields: UnknownFieldPolicy
}

pub type JsonMigration = fn(
  version: i32,
  document: JsonValue
) -> Result<JsonValue, JsonDecodeError>
```

The exact new callable surface is:

```voyd
pub fn strict_decode_options() -> JsonDecodeOptions
pub fn permissive_decode_options() -> JsonDecodeOptions

pub fn decode<T>(source: String): () -> Result<T, JsonDecodeError>
pub fn decode<T>(source: StringSlice): () -> Result<T, JsonDecodeError>
pub fn decode<T>(source: String, { options: JsonDecodeOptions }): () -> Result<T, JsonDecodeError>
pub fn decode<T>(source: StringSlice, { options: JsonDecodeOptions }): () -> Result<T, JsonDecodeError>
pub fn decode<T>(value: JsonValue): () -> Result<T, JsonDecodeError>
pub fn decode<T>(value: JsonValue, { options: JsonDecodeOptions }): () -> Result<T, JsonDecodeError>

pub fn decode_versioned<T>(
  source: String,
  { current current_version: i32, migrate: JsonMigration }
): () -> Result<T, JsonDecodeError>
pub fn decode_versioned<T>(
  source: StringSlice,
  { current current_version: i32, migrate: JsonMigration }
): () -> Result<T, JsonDecodeError>
pub fn decode_versioned<T>(
  document: JsonValue,
  { current current_version: i32, migrate: JsonMigration }
): () -> Result<T, JsonDecodeError>

pub fn number_in_range(
  value: JsonValue,
  { at path: String, min: f64, max: f64 }
): () -> Result<f64, JsonDecodeError>
pub fn number_in_range(
  value: JsonValue,
  { at path: StringSlice, min: f64, max: f64 }
): () -> Result<f64, JsonDecodeError>
```

`decode<T>` supports the value-bearing subset of the derived shape family:
`bool`, integer and floating-point values, `String`, arrays, records, optional
fields, references, and tagged unions. `void` is not a valid target because
`Result<T, JsonDecodeError>` requires a concrete success payload. Functions,
traits, unresolved type parameters, implementation containers such as `Dict`,
private runtime state, and ambiguous duplicate variant discriminators are also
unsupported. It is strict by default: an unknown record field is a schema
error. The permissive option ignores unknown fields but continues to validate
all known fields.

```voyd
use std::json::{ decode, permissive_decode_options }

obj Profile { name: String }

let exact = decode<Profile>("{\"name\":\"Ada\"}")
let forward_compatible = decode<Profile>(
  "{\"name\":\"Ada\",\"future\":true}",
  options: permissive_decode_options()
)
```

JSON numbers for `i32` and `i64` must be integral and in range. An `f32` must
remain finite after demotion; `f64` uses the parsed JSON number. Errors retain a
rooted path such as `$.profiles[1].age`; parse errors use `$`. Tagged unions use
an object with `$variant` and sibling payload fields, while a payload-free
variant may also be represented by its name as a JSON string.

`decode_versioned` requires an object with an integral 32-bit `version`. A
document already at `current` decodes directly. Any other version is passed to
the supplied migration callback, and a successful migration must return a
document whose version equals `current`; the migrated document is then decoded
strictly.

```voyd
fn migrate(version: i32, document: JsonValue)
  -> Result<JsonValue, JsonDecodeError>
  // Return a document with the requested current version, or a typed error.
  migrate_document(version, document)

let profile = decode_versioned<ProfileDocument>(
  source,
  current: 2,
  migrate: migrate
)
```

`number_in_range` requires a JSON number that is finite and within the inclusive
`min...max` range; it reports a schema or constraint error at the caller's `at`
path. Existing `parse`, `stringify`, and `stringify_pretty` signatures and
untyped behavior are unchanged.

```voyd
use std::json::{ JsonNumber, number_in_range }

let confidence = number_in_range(
  JsonNumber { value: 0.85 },
  at: "$.confidence",
  min: 0.0,
  max: 1.0
)
```

### Filesystem operations and portable I/O errors

`std::error::IoError` changes to:

```voyd
pub obj IoNotFound {}
pub obj IoAlreadyExists {}
pub obj IoPermissionDenied {}
pub obj IoConflict {}
pub obj IoOther {}

pub type IoErrorKind = IoNotFound
  | IoAlreadyExists
  | IoPermissionDenied
  | IoConflict
  | IoOther

pub obj IoError {
  api kind: IoErrorKind,
  api code: i32,
  api message: String
}
```

The raw `Fs` operations and typed wrappers added by the branch are:

```voyd
// Raw effect operations; payload is { path, kind, value|bytes }.
write_atomic(tail, payload: MsgPack) -> MsgPack
create_exclusive(tail, payload: MsgPack) -> MsgPack

pub fn write_atomic(path: Path, bytes: Bytes): Fs -> Result<Unit, IoError>
pub fn write_atomic(path: Path, value: String): Fs -> Result<Unit, IoError>
pub fn write_atomic(path: Path, value: StringSlice): Fs -> Result<Unit, IoError>

pub fn create_exclusive(path: Path, bytes: Bytes): Fs -> Result<Unit, IoError>
pub fn create_exclusive(path: Path, value: String): Fs -> Result<Unit, IoError>
pub fn create_exclusive(path: Path, value: StringSlice): Fs -> Result<Unit, IoError>
```

```voyd
use std::fs::{ create_exclusive, write_atomic }
use std::path::Path

let path = Path::new("./data/state.json")
let first = create_exclusive(path, "{\"version\":1}")
let replaced = write_atomic(path, "{\"version\":2}")
```

`create_exclusive` permits one creator and reports an existing target as
`IoAlreadyExists`. `write_atomic` writes an exclusively created temporary in the
same directory and renames it only after the complete write. Successful readers
therefore see the old complete file or the new complete file. This is an atomic
replacement guarantee, not crash durability: the API does not promise file or
directory `fsync`.

The bundled Node/Deno adapter tries at most 16 temporary names, cleans a
temporary best-effort after write or rename failure, and preserves the original
error. Node uses `writeFile(..., { flag: "wx" })`; Deno uses `createNew: true`.
Portable categorization is:

- `ENOENT` / `NotFound` -> `IoNotFound`;
- `EEXIST` / `AlreadyExists` -> `IoAlreadyExists`;
- `EACCES`, `EPERM`, or `PermissionDenied` -> `IoPermissionDenied`;
- `EBUSY`, `ETXTBSY`, `ENOTEMPTY`, or `Busy` -> `IoConflict`;
- all other or missing kinds -> `IoOther`.

Native numeric `code` and `message` remain available. Older/custom host payloads
without `kind`, and I/O failures decoded by `std::input` or `std::output`, become
`IoOther`.

### RFC 3339 UTC timestamps

`std::time` adds:

```voyd
pub obj TimestampError {
  api code: i32,
  api index: i32,
  api message: String
}

pub fn timestamp_error_code_invalid_format() -> i32       // 1
pub fn timestamp_error_code_invalid_date() -> i32         // 2
pub fn timestamp_error_code_invalid_time() -> i32         // 3
pub fn timestamp_error_code_invalid_offset() -> i32       // 4
pub fn timestamp_error_code_out_of_range() -> i32         // 5
pub fn timestamp_error_code_unsupported_precision() -> i32 // 6
pub fn timestamp_error_code_overflow() -> i32             // 7
pub fn timestamp_error_code_formatting() -> i32           // 8

impl SystemTime
  api fn from_unix_millis(value: i64) -> SystemTime
  api fn parse_rfc3339(source: StringSlice): () -> Result<SystemTime, TimestampError>
  api fn parse_rfc3339(source: String): () -> Result<SystemTime, TimestampError>
  api fn to_rfc3339(self): () -> Result<String, TimestampError>
```

Parsing accepts `T`/`t`, `Z`/`z`, numeric `+HH:MM` or `-HH:MM` offsets, whole
seconds, and one to three fractional digits. It normalizes offsets to UTC and
rejects malformed or impossible Gregorian dates, invalid wall-clock values and
offsets, leap seconds, and precision beyond milliseconds. `index` is the
associated byte position; formatting failures use `-1`.

```voyd
use std::time::SystemTime

let epoch = SystemTime::from_unix_millis(0).to_rfc3339()
// Ok("1970-01-01T00:00:00.000Z")

let instant = SystemTime::parse_rfc3339("2026-08-08T12:34:56.25+02:00")
// Normalized to 2026-08-08T10:34:56.250Z.
```

Formatting always uses `YYYY-MM-DDTHH:MM:SS.mmmZ` and supports RFC 3339's
four-digit years `0000...9999`.

### Locale-independent number formatting

`std::number::cast` adds:

```voyd
pub obj NonFinitePolicy { kind: i32 }
impl NonFinitePolicy
  api fn symbols() -> NonFinitePolicy
  api fn reject() -> NonFinitePolicy

pub obj NumberFormatError {
  api code: i32,
  api message: String
}

pub fn number_format_error_code_invalid_precision() -> i32 // 1
pub fn number_format_error_code_non_finite() -> i32         // 2
```

All six formatter overloads are:

```voyd
pub fn format_fixed(
  value: f64,
  { decimal_places: i32, trim_trailing_zeros: bool = false,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>
pub fn format_fixed(
  value: f32,
  { decimal_places: i32, trim_trailing_zeros: bool = false,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>

pub fn format_significant(
  value: f64,
  { digits: i32, trim_trailing_zeros: bool = true,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>
pub fn format_significant(
  value: f32,
  { digits: i32, trim_trailing_zeros: bool = true,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>

pub fn format_scientific(
  value: f64,
  { digits: i32, trim_trailing_zeros: bool = true,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>
pub fn format_scientific(
  value: f32,
  { digits: i32, trim_trailing_zeros: bool = true,
    non_finite: NonFinitePolicy = NonFinitePolicy::symbols() }
): () -> Result<String, NumberFormatError>
```

`format_fixed` accepts `decimal_places` in `0...15`.
`format_significant` and `format_scientific` accept `digits` in `1...16`.
Rounding is IEEE-754 ties-to-even, negative zero is rendered unsigned, and no
locale grouping is applied. `format_significant` selects fixed notation for
decimal exponents `-6...20` inclusive and compact lowercase scientific notation
outside that range. Scientific output uses forms such as `1.25e6`, without a
`+` sign in a positive exponent.

```voyd
let price = format_fixed(12.5, decimal_places: 2)
// Ok("12.50")

let population = format_significant(1234567.0, digits: 3)
// Ok("1230000") because exponent 6 remains in the fixed range.

let tiny = format_scientific(0.0000125, digits: 3)
// Ok("1.25e-5")
```

`NonFinitePolicy::symbols()` returns `NaN`, `Infinity`, or `-Infinity`.
`NonFinitePolicy::reject()` returns error code 2. Out-of-range precision returns
code 1.

### Secure bytes and UUIDs

`std::random` adds:

```voyd
pub obj RandomError {
  api code: i32,
  api message: String
}
pub fn random_error_code_invalid_length() -> i32  // 1
pub fn random_error_code_invalid_payload() -> i32 // 2

pub obj UuidParseError {
  api index: i32,
  api message: String
}

pub obj Uuid { bytes: Bytes }
impl Uuid
  api fn v4(): Random -> Result<Uuid, RandomError>
  api fn parse(source: StringSlice): () -> Result<Uuid, UuidParseError>
  api fn parse(source: String): () -> Result<Uuid, UuidParseError>
  api fn is_valid(source: StringSlice) -> bool
  api fn is_valid(source: String) -> bool
  api fn to_string(self) -> String

pub fn secure_bytes(len: i32): Random -> Result<Bytes, RandomError>
```

`secure_bytes` rejects a negative length with code 1. Zero returns an empty
buffer without invoking the host. For positive lengths the host result must be
an array of exactly `len` integer values in `0...255`; a wrong container,
length, element type, or range returns code 2. Values are neither normalized nor
replaced by a pseudo-random fallback.

```voyd
use std::random::{ Uuid, secure_bytes }

let nonce = secure_bytes(32)
let generated = Uuid::v4()
let parsed = Uuid::parse("00010203-0405-4607-8809-0A0B0C0D0E0F")
```

`Uuid::v4` requests 16 secure bytes and sets the version-4 and RFC variant bits.
`parse` requires the canonical 36-byte `8-4-4-4-12` hyphen layout and accepts
upper- or lowercase hexadecimal. It validates UUID text layout, not a required
version number. `to_string` always returns lowercase canonical text.

The bundled random adapter requires non-negative integer lengths and rejects
requests above the smaller of 1,000,000 bytes and the exact response size that
fits the configured effect buffer. Web Crypto calls are internally split into
65,536-byte chunks. Oversized requests are rejected with guidance to split the
Voyd request; they are never silently clamped.

### Approximate numeric test assertions

The new `std::test::numeric` API is:

```voyd
pub fn assert_close(
  actual: f64,
  { to expected: f64,
    absolute: f64 = 0.000000000001,
    relative: f64 = 0.000000001,
    message: String = String::init() }
): Test -> void

pub fn assert_close(
  actual: f32,
  { to expected: f32,
    absolute: f32 = to_f32(0.00001),
    relative: f32 = to_f32(0.00001),
    message: String = String::init() }
): Test -> void
```

It passes when
`abs(actual - expected) <= max(absolute, relative * max(abs(actual), abs(expected)))`.
Equal infinities and signed zeros pass. NaN, unequal infinities, negative
tolerances, and non-finite tolerances fail.

```voyd
use std::test::numeric::assert_close

test "integrator conserves energy":
  assert_close(
    measured_energy(),
    to: expected_energy,
    absolute: 0.000000001,
    relative: 0.000001,
    message: "energy after 1,000 steps"
  )
```

Failures include actual, expected, delta, both tolerances, and the optional
message. `Test::fail_with(resume, pointer, byte_len)` is the low-level UTF-8
transport used to carry that detail from Wasm; application tests should call
`assert_close`. The SDK validates the pointer/range and strictly decodes UTF-8,
falling back to the generic `Test failed` text for an invalid transport. CLI
output includes the decoded detail and the test declaration's source location.

## Web framework

The signatures of the query APIs are unchanged:

```voyd
pub fn extract_query<T>(query: QueryParams) -> Result<T, Rejection>
pub fn validate_query<T>(query: QueryParams) -> Option<Rejection>
pub fn decode_query<T>(query: QueryParams) -> T
```

Their behavior is now driven by the declared shape of `T`. `T` must resolve to
a record. Query strings stay exact strings, `bool` accepts only `true` or
`false`, `i32` and `i64` accept canonical decimal spelling and enforce range,
and `f32`/`f64` use floating-point parsing. Optional fields may be absent.
Missing required fields, bad spelling, bad type, overflow, and a non-record
target produce a `400` rejection that names the field. Unknown query keys are
ignored by the declared-field validation and derived record decoder. A single
URL scalar cannot manufacture an array, nested record, or tagged union, so
those shapes fail validation unless another boundary supplies the required
structured value.

```voyd
obj SearchQuery {
  term: String,
  page?: i32,
  exact: bool
}

// ?term=true&page=2&exact=false
// term is the string "true"; page is i32 2; exact is bool false.
let result = extract_query<SearchQuery>(query)
```

`extract_query` validates and returns `Result`; `validate_query` performs the
same validation without decoding; `decode_query` is the unchecked companion and
can panic when used on invalid input.

The Web package root no longer contains `pub src::all`, so the legacy child
module backed by `src/all.voyd` is not part of the public package surface. This
does not remove the language's `all` selection: `use pkg::web::all` remains
valid and selects the curated exports of the package root. Consumers may also
select those exports individually. The public route-building macro is now owned
by the package root:

```voyd
pub macro serve(first, second)
```

Its call syntax is unchanged. It still accepts an app/build form or a route DSL,
infers route helpers from handler parameters named `params`, `query`, `headers`,
`cookies`, and optional final `ctx`, accepts at most one `openapi:` argument,
and delegates to `serve_app` or `serve_build`. The implementation now uses
definition-site symbol references, so caller names cannot capture its router,
method, extractor, or OpenAPI helpers. Import and call it from `pkg::web::serve`.

```voyd
use pkg::web::{ Context, Response, serve }

let result = serve(port: 3000, host: "127.0.0.1") routes():
  get("/") do:
    Response::ok().text("hello")

  get("/users/:id") do(ctx: Context):
    Response::ok().text(ctx.param("id") ?? "unknown")
```

## VX markup, DOM, events, and Canvas

### Tag-aware JSX form values

Built-in JSX now lowers `value`, `checked`, and `disabled` according to the HTML
tag rather than treating each spelling as an unconditional DOM property.

| JSX spelling | Supported tags | Representation |
| --- | --- | --- |
| `value` | `input` | live property in the browser; `value` attribute in SSR |
| `value` | `textarea` | live property in the browser; text content in SSR when compatible with children |
| `value` | `button`, `data`, `li`, `meter`, `option`, `param`, `progress` | ordinary HTML attribute |
| `checked` | `input` | live property; boolean attribute in SSR |
| `disabled` | `button`, `fieldset`, `input`, `optgroup`, `option`, `select`, `textarea` | live property; boolean attribute in SSR |

Unsupported combinations are parser errors at the attribute range. The message
names the property and tag; `<select value=...>` recommends `selected` on its
matching `<option>`, and `<option checked=...>` recommends `selected`.

```voyd
<select>
  <option value="earth" selected={selected == "earth"}>Earth</option>
  <option value="mars" selected={selected == "mars"}>Mars</option>
</select>
```

The explicit `prop({ name, value })` helper remains available for browser-only
rendering. Server rendering rejects a property/tag pair without a stable HTML
representation. Browser updates and hydration preserve option `value` and
`selected`; textarea property state has a stable text representation only when
it is compatible with the rendered children.

### Canvas v2 types and calls

The new public data types are:

```voyd
pub val CanvasTransform {
  api a: f64, api b: f64, api c: f64,
  api d: f64, api e: f64, api f: f64
}

pub obj CanvasPathSegment {
  api payload: MsgPack,
  pri dto?: CanvasPathSegmentDto
}

pub enum CanvasFillRule
  NonZero
  EvenOdd

pub enum CanvasCompositeOperation
  SourceOver
  SourceIn
  SourceOut
  SourceAtop
  DestinationOver
  DestinationIn
  DestinationOut
  DestinationAtop
  Lighter
  Copy
  Xor
  Multiply
  Screen
  Overlay
  Darken
  Lighten
  ColorDodge
  ColorBurn
  HardLight
  SoftLight
  Difference
  Exclusion
  Hue
  Saturation
  Color
  Luminosity

pub type CanvasTextMetrics = {
  width: f64,
  actual_bounding_box_left: f64,
  actual_bounding_box_right: f64,
  actual_bounding_box_ascent: f64,
  actual_bounding_box_descent: f64
}
```

All new path constructors are:

```voyd
pub fn canvas_path_move_to(point: CanvasPoint) -> CanvasPathSegment
pub fn canvas_path_line_to(point: CanvasPoint) -> CanvasPathSegment
pub fn canvas_path_quadratic_curve_to(
  { control: CanvasPoint, to: CanvasPoint }
) -> CanvasPathSegment
pub fn canvas_path_bezier_curve_to(
  { control_1: CanvasPoint, control_2: CanvasPoint, to: CanvasPoint }
) -> CanvasPathSegment
pub fn canvas_path_arc(
  { center: CanvasPoint, radius: f64, start_angle: f64, end_angle: f64,
    counter_clockwise: bool = false }
) -> CanvasPathSegment
pub fn canvas_path_arc_to(
  { control_1: CanvasPoint, control_2: CanvasPoint, radius: f64 }
) -> CanvasPathSegment
pub fn canvas_path_ellipse(
  { center: CanvasPoint, radius_x: f64, radius_y: f64, rotation: f64,
    start_angle: f64, end_angle: f64,
    counter_clockwise: bool = false }
) -> CanvasPathSegment
pub fn canvas_path_rect(
  { origin: CanvasPoint, width: f64, height: f64 }
) -> CanvasPathSegment
pub fn canvas_path_close() -> CanvasPathSegment

pub fn canvas_path(
  { segments: Array<CanvasPathSegment>, fill?: String, stroke?: String,
    stroke_width: f64 = 1.0,
    fill_rule: CanvasFillRule = CanvasFillRule::NonZero {},
    alpha: f64 = 1.0, glow_color?: String, glow_blur: f64 = 0.0 }
) -> CanvasDraw
```

Angles and rotation use radians. Points and dimensions use logical CSS pixels.
The new ordered state operations are:

```voyd
pub fn canvas_save() -> CanvasDraw
pub fn canvas_restore() -> CanvasDraw
pub fn canvas_transform(matrix: CanvasTransform) -> CanvasDraw
pub fn canvas_translate({ x: f64, y: f64 }) -> CanvasDraw
pub fn canvas_rotate(radians: f64) -> CanvasDraw
pub fn canvas_scale({ x: f64, y: f64 }) -> CanvasDraw
pub fn canvas_line_dash(
  { pattern: Array<f64>, offset: f64 = 0.0 }
) -> CanvasDraw
pub fn canvas_composite(operation: CanvasCompositeOperation) -> CanvasDraw
```

`save` and `restore` preserve transform, dash, compositing, and paint state.
An empty dash pattern resets the dash. The existing changed frame and gradient
constructors have these exact signatures:

```voyd
pub fn canvas_radial_gradient(
  { inner_color: String, outer_color: String,
    inner_radius: f64 = 0.0, outer_radius?: f64 }
) -> CanvasRadialGradient

pub fn canvas_frame(
  { selector: String, width: f64, height: f64,
    draws: Array<CanvasDraw>, clear: bool = true, background?: String }
) -> CanvasFrame
```

`canvas_frame` now emits `version: 2`. The existing line, polyline, circle,
ellipse, text, and radial-gradient constructors remain usable in a v2 frame.
`CanvasPathSegment`, `CanvasDraw`, and `CanvasRadialGradient` now have a private
optional typed DTO cache. External code can read `payload` but can no longer
construct these nominal objects with raw object literals; use the typed
constructors. A host-originated payload can omit the cache and is decoded when
composed, preserving wire compatibility.

```voyd
use std::vx::{
  CanvasPoint,
  canvas_frame,
  canvas_path,
  canvas_path_line_to,
  canvas_path_move_to
}

let frame = canvas_frame({
  selector: "#orbit-canvas",
  width: 640.0,
  height: 480.0,
  draws: [canvas_path({
    segments: [
      canvas_path_move_to(CanvasPoint { x: 10.0, y: 10.0 }),
      canvas_path_line_to(CanvasPoint { x: 100.0, y: 100.0 })
    ],
    stroke: "#ffffff"
  })]
})
```

Text measurement is a new asynchronous command with two exact overloads:

```voyd
impl<Msg> Cmd<Msg>
  api fn canvas_measure_text(
    { selector: String, value: String, font: String = "12px sans-serif",
      handler_id: i32 }
  ) -> Cmd<Msg>

  api fn canvas_measure_text(
    { selector: String, value: String, font: String = "12px sans-serif",
      handler: fn(CanvasTextMetrics) -> Msg }
  ) -> Cmd<Msg>
```

There are no `StringSlice` overloads for this command. The browser finds the
selected canvas, applies the font, returns logical CSS-pixel metrics, dispatches
the retained typed mapper, and releases an owned mapper once. Missing targets,
invalid commands, measurement, mapping, and observer failures are reported
through the runtime's `commands` error phase.

```voyd
let measure = Cmd<Msg>::canvas_measure_text(
  selector: "#orbit-canvas",
  value: model.session.name,
  font: "600 12px Inter, sans-serif",
  handler: (metrics: CanvasTextMetrics) -> Msg =>
    Msg::CanvasTitleMeasured { metrics }
)
```

### Canvas host validation and rendering

The browser host validates a whole Canvas frame before resizing or painting the
target. Version 1 remains accepted for legacy line, polyline, circle, ellipse,
and text draws. Paths and ordered state operations require version 2.

Validation rejects non-finite dimensions and draw arguments, negative radii,
unknown path/draw/state kinds, unsupported fill rules or composites, invalid
gradient colors, an unmatched `restore`, leftover unmatched `save` operations,
negative/non-finite dash entries, and a non-empty dash whose entries are all
zero. Rejected frames leave the target size and pixels untouched.

Applications continue to work in logical CSS pixels. The host owns the backing
store size and applies `devicePixelRatio` scaling so callers do not pre-scale
coordinates, line widths, or text metrics.

### Pointer cancellation and capture

Voyd `EventOptions` adds:

```voyd
pub obj EventOptions {
  api prevent_default?: bool,
  api stop_propagation?: bool,
  api capture?: bool,
  api passive?: bool,
  api pointer_capture?: bool
}
```

Voyd `MouseEvent` adds the required `pointer_id: i32` field. Pointer events use
their browser `PointerEvent.pointerId`; ordinary mouse, wheel, and drag events
use `0`.

The complete new pointer-cancel helper family is:

```voyd
pub fn on_pointer_cancel(handler: fn() -> MsgPack): () -> MsgPack
pub fn on_pointer_cancel_payload(handler: fn(MsgPack) -> MsgPack): () -> MsgPack
pub fn on_pointer_cancel(handler_id: i32): () -> MsgPack
pub fn on_pointer_cancel_message(message: MsgPack): () -> MsgPack
pub fn on_pointer_cancel_with(
  { options: EventOptions, handler_id: i32 }
): () -> MsgPack
pub fn on_pointer_cancel_with(
  { options: EventOptions, handler: fn() -> MsgPack }
): () -> MsgPack
pub fn on_pointer_cancel_with(
  { options: EventOptions, message: MsgPack }
): () -> MsgPack
pub fn on_pointer_cancel_payload_with(
  { options: EventOptions, handler: fn(MsgPack) -> MsgPack }
): () -> MsgPack
pub fn on_pointer_cancel_message<Msg>(message: Msg): () -> MsgPack
pub fn on_pointer_cancel_with<Msg>(
  { options: EventOptions, message: Msg }
): () -> MsgPack
```

When `pointer_capture` is true on a `pointerdown` listener, the browser calls
`setPointerCapture` for that pointer. It releases matching capture on
`pointerup` or `pointercancel`. Pointer-capture state participates in listener
identity, so changing the option replaces the listener correctly.

```voyd
let cancel_event = on_pointer_cancel_with({
  options: EventOptions { prevent_default: true },
  handler_id: cancel_handler_id
})
```

At the TypeScript host layer, the corresponding changes are:

```ts
type EventOptions = {
  preventDefault?: boolean;
  stopPropagation?: boolean;
  capture?: boolean;
  passive?: boolean;
  pointerCapture?: boolean;
};

type MouseEventPayload = {
  kind: "mouse" | "pointer" | "wheel" | "drag";
  pointer_id: number;
  // existing coordinate, button, modifier, and delta fields...
};
```

See [VX](../../packages/reference/docs/vx.md) for the complete existing element,
event, command, subscription, and Canvas APIs.

## JavaScript host and SDK

The principal managed-run signatures do not change:

```ts
type RunOutcome<T = unknown> =
  | { kind: "value"; value: T }
  | { kind: "failed"; error: Error }
  | { kind: "cancelled"; reason?: unknown };

type VoydRunHandle<T = unknown> = {
  id: string;
  outcome: Promise<RunOutcome<T>>;
  cancel: (reason?: unknown) => boolean;
  observeTask?: (taskId: number) => Promise<RunOutcome<unknown>>;
};

host.runManaged<T>(entryName: string, args?: unknown[]): VoydRunHandle<T>
host.runEffectfulManaged<T>(entryName: string, args?: unknown[]): VoydRunHandle<T>
host.run<T>(entryName: string, args?: unknown[]): Promise<T>
host.runEffectful<T>(entryName: string, args?: unknown[]): Promise<T>
```

Their failure contract is stronger. A terminal typed task value is encoded and
mapped once, then reused for the root `outcome` and every observer. A VM-to-host
encoding failure, effect-buffer overflow, or host decode/schema failure settles
the task as `{ kind: "failed", error }` instead of leaving the handle pending.
`run` and `runEffectful` unwrap that outcome and reject. Task observation uses
the same stored terminal failure.

Traps at this boundary carry transition metadata equivalent to:

```ts
{ point: "task_outcome", direction: "vm->host" }
```

and retain a source-function fallback. Detached tasks still report genuinely
unobserved failures. Observer and retained-mapper failures cannot strand the VX
event loop; VX routes them through its error phases and releases owned retained
handlers exactly once.

Default adapter behavior changes in two places:

- filesystem handlers implement the new raw operations and portable error
  kinds described above;
- `DefaultAdapterRuntimeHooks.randomBytes?: (length: number) => Uint8Array`
  must return a `Uint8Array` whose `byteLength` equals `length`. A non-typed
  array, short buffer, or long buffer is an error.

The SDK's compile/run surface is unchanged. Its test runner now implements
`Test::fail_with`, safely reads the specified exported-memory range, strictly
decodes UTF-8, and puts the detail into the existing failed test event. This is
the path that makes `assert_close` details visible to SDK and CLI consumers.

## CLI and language-server behavior

`voyd test` keeps its command and option syntax. Directory runs now group test
modules by their owning nested source package and compile a synthetic entry
inside each package. Tests may therefore exercise package-private declarations
without flattening or weakening the package boundary.

The runner aggregates results across package batches. `test only` remains
global: when any eligible test anywhere in the selected run is marked `only`,
ordinary tests in every package batch are skipped, while explicit skips remain
reported. Sharding/filtering selects tests before package grouping. A physical
`pkg.voyd` test module is addressed by its logical directory path rather than a
spurious trailing `::pkg`.

Failed lines now include both decoded failure detail and the test declaration
location, for example:

```text
FAIL integrator conserves energy (.../engine.test.voyd:42:1)
  actual=..., expected=..., delta=..., absolute=..., relative=...
```

No code-test suite or source-discovery CLI flag was added.

Language-server behavior follows compiler symbol identity:

- completion after an effect qualifier lists only that effect's operations;
- completion after a module qualifier excludes effect operations;
- unqualified completion includes only explicitly selected operation aliases;
- hover describes `effect operation Effect::op(...)`, continuation mode,
  stable effect ID, declaring module, source, and any local alias;
- go-to-definition and rename keep an operation separate from same-named
  wrappers and from operations of other effects;
- generated hygienic helpers navigate/rename at their visible definition syntax
  with a distinct identity per invocation;
- labeled parameters, including external labels, participate correctly in
  rename;
- compiler-only enum implementation symbols are omitted from user completion
  and navigation.

## Voyd Orbit workflow and wire behavior

Voyd Orbit exercises the changes as a full-stack application. Its source layout
now uses nested package roots:

```text
src/shared/pkg.voyd
src/simulation/pkg.voyd
src/client/pkg.voyd
src/server/pkg.voyd
```

Logical imports such as `src::simulation::default_scenario` do not change. The
browser compiler entry changes from `src/client.voyd` to `src/client/pkg.voyd`,
and the test script groups files by owning package. This makes Orbit's build and
tests demonstrate the same visibility boundaries enforced by the compiler and
CLI.

Persistence IDs change from 32 lowercase hexadecimal digits to lowercase
canonical UUID text. `SimulationRepository::path_for(self, id: String)` now
accepts only text equal to `Uuid::parse(id).to_string()`; uppercase canonical
UUID input is parseable by `Uuid` but rejected as a repository ID because it is
not already canonical lowercase. Creation tries up to eight secure UUIDs and
returns `id-generation-failed` if entropy fails or no unused ID is found.

New simulations use `fs::create_exclusive`; updates use `fs::write_atomic`.
Directory listing independently skips temporary, unrelated, noncanonical,
unreadable, malformed, ID-mismatched, or validation-failing files so one bad
save does not hide healthy simulations. Portable repository errors are:

- `storage-not-found` for `IoNotFound`;
- `storage-conflict` for `IoAlreadyExists` or `IoConflict`;
- `storage-permission-denied` for `IoPermissionDenied`;
- `storage-failed` for `IoOther`;
- `id-generation-failed` for secure entropy/allocation failure.

All storage categories map to server errors; invalid request IDs and validation
problems remain client errors. Create conflicts can no longer overwrite another
creator's file, and updates cannot expose partially written JSON.

Orbit preserves its readable version-1 JSON field names, including `createdAt`,
`updatedAt`, `massSolar`, `positionAu`, `simulationSettings`, and `bodyCount`.
The following public return types change:

```voyd
pub fn simulation_from_json(
  source: String
) -> Result<PersistedSimulation, JsonDecodeError>

pub fn simulation_from_json_value(
  value: JsonValue
) -> Result<PersistedSimulation, JsonDecodeError>

pub fn summaries_from_json(
  source: String
) -> Result<Array<SimulationSummary>, JsonDecodeError>

pub fn api_error_from_json(
  source: String
) -> Result<ApiError, JsonDecodeError>
```

The readers now reject unknown fields, missing nested fields, wrong scalar
types, out-of-range integers, unknown versions, and unknown body kinds with a
rooted path. They no longer silently replace missing strings/numbers/booleans,
camera objects, appearance objects, or settings with empty/zero/default values.
Writing still uses the existing readable v1 schema; no automatic migration is
introduced.

The client uses canonical RFC 3339 timestamps and the new number formatters for
stable labels. An API task whose typed outcome cannot cross the host boundary
now produces a normal failed result, allowing the interactive update loop to
remain usable.

Orbit also adds one public helper around the new Canvas command:

```voyd
pub fn measure_title<Msg>(
  value: String,
  { handler: fn(CanvasTextMetrics) -> Msg }
) -> Cmd<Msg>
```

It measures with the same `600 12px Inter, sans-serif` font used for drawing.
Initialization, scenario changes, loaded simulations, and session-name edits
request a new measurement; the returned width redraws the title panel. Scene
drawing now demonstrates Canvas paths, transforms, balanced save/restore,
dashes, compositing, and measured text. Pointer messages carry a pointer ID,
the canvas captures on press, cancellation returns the interaction to idle, and
move/release/cancel messages from a non-active pointer are ignored. The scenario
picker uses per-option `selected` state so browser and SSR behavior agree.

Orbit's simulation tests now use `assert_close` for floating-point contracts.
The application journey and operational details are recorded in
[Voyd Orbit JOURNEY](../../examples/voyd-orbit/JOURNEY.md) and
[Voyd Orbit README](../../examples/voyd-orbit/README.md).

## Low-level TypeScript package exports

Most compiler changes are internal to binding, typing, lowering, and codegen;
the `@voyd-lang/compiler` root `compileProgram` signature does not change. Three
importable low-level package contracts do change and may affect custom tooling.

First, `@voyd-lang/js-host/adapters/default/helpers.js` changes the exported
helper to accept a portable kind:

```ts
hostError(
  message: string,
  code?: number, // defaults to 1
  kind?: string,
): Record<string, unknown>
```

When `kind` is omitted, the property is omitted for backward-compatible host
payloads. The exported adapter type changes to:

```ts
type NodeFsPromises = {
  // existing methods...
  writeFile: (
    path: string,
    data: string | Uint8Array,
    options?: { flag?: string },
  ) => Promise<void>;
};
```

```ts
import { hostError } from "@voyd-lang/js-host/adapters/default/helpers.js";

const payload = hostError("destination already exists", 17, "already-exists");
```

Second, `@voyd-lang/vx-dom/normalize.js` adds:

```ts
type SsrDomPropertyRepresentation = "attribute" | "text" | "unsupported";

function ssrDomPropertyRepresentation(
  tag: string,
  property: string,
): SsrDomPropertyRepresentation;
```

It returns `attribute` for `input.value`, `input.checked`, and supported
`disabled` tags; `text` for `textarea.value`; and `unsupported` otherwise. This
is a subpath export, not a new root export from `@voyd-lang/vx-dom`.

```ts
import { ssrDomPropertyRepresentation } from "@voyd-lang/vx-dom/normalize.js";

ssrDomPropertyRepresentation("textarea", "value"); // "text"
ssrDomPropertyRepresentation("select", "value");   // "unsupported"
```

Third, `@voyd-lang/lib/binaryen-gc/index.js` adds:

```ts
function annotateTypeName(
  mod: binaryen.Module,
  typeRef: HeapTypeRef,
  name: string,
): void;
```

`defineArrayType`, `annotateStructNames`, and `refFunc` now allocate and free
stable UTF-8 strings around Binaryen calls instead of relying on a stack-backed
pointer. `AugmentedBinaryen` no longer declares
`stringToUTF8OnStack(str: string): number`; custom code typed against that
internal augmentation must use the safe helper or manage a pointer explicitly.

```ts
import { annotateTypeName } from "@voyd-lang/lib/binaryen-gc/index.js";

annotateTypeName(module, heapType, "Profile");
```

All other newly exported helpers in nested compiler source modules support the
compiler's internal `ProgramCodegenView`, replayable-value lowering, macro
identity, or effect-resolution contracts. They are not re-exported from the
package root and do not add Voyd source or supported end-user compiler API.

## Migration checklist and further reading

Before adopting this branch:

1. Search effects for duplicate operation names and closed handlers for `Fs` or
   `Test`.
2. Add `kind` to constructed `IoError` values and handle the five portable
   variants.
3. Replace raw Canvas wrapper literals with constructors, accept Canvas wire v2,
   and add `pointer_id` to event fixtures.
4. Remove `foo.voyd`/`foo/pkg.voyd` path collisions and expose nested-package API
   through `pkg.voyd` with `api` members where needed.
5. Stop importing the legacy Web child module or router-owned route-DSL macro;
   import from the curated package root, either explicitly or with the valid
   `use pkg::web::all` selection.
6. Treat derived MessagePack field/variant spelling as wire schema and choose
   strict or permissive JSON decoding intentionally.
7. Update host random hooks and filesystem mocks to the exact contracts above.
8. Rename or migrate legacy Orbit save IDs and update JSON-reader error matches.

Detailed language reference pages updated by the branch are:

- [Functions](../../packages/reference/docs/functions.md)
- [Syntax](../../packages/reference/docs/syntax.md)
- [Macros](../../packages/reference/docs/macros.md)
- [Modules](../../packages/reference/docs/modules.md)
- [Visibility](../../packages/reference/docs/visibility.md)
- [Effects](../../packages/reference/docs/types/effects.md)
- [Enums](../../packages/reference/docs/types/enums.md)
- [Objects](../../packages/reference/docs/types/objects.md)
- [Traits](../../packages/reference/docs/types/traits.md)
- [Type shapes and codecs](../../packages/reference/docs/type-shapes-and-codecs.md)
- [VX](../../packages/reference/docs/vx.md)
- [CLI](../../packages/reference/docs/cli.md)
