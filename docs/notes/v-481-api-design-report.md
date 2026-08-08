# V-481 external API design report

This report collects the externally observable language, standard-library, host,
and VX decisions made while completing V-481 and its subtickets. It is intended
for API review; implementation-only changes are called out explicitly where they
alter failure behavior without adding a callable surface.

## V-482 — Observational single evaluation

Voyd guarantees observational single evaluation for each dynamic source
expression occurrence after macro expansion. Runtime type tests, coercions,
projections, pattern checks, field loads, and runtime guards consume the same
stabilized result; explicit source occurrences evaluate separately. An empty
effect row is not a repeatability proof because allocation identity, traps,
divergence, fresh closures, and mutable objects remain observable. A macro that
emits an input more than once must bind that input once.

Optimizers may rematerialize only with an observational-equivalence proof and
may not move setup across control flow, effect handlers or suspension,
argument/default ordering, borrow activation, or runtime guards. No new
library/API symbol is introduced; this is a language semantic guarantee.

## V-483 — Task settlement failure semantics

No callable API or public type signatures change. `VoydRunHandle.outcome` and
`observeTask` now guarantee terminal settlement when VM-to-host task-result
encoding or decoding fails. Typed results are mapped once at settlement and
reused by public outcomes and observers. Observable errors distinguish task
outcome encoding, oversized payload, and decoding failures. Wasm traps at this
boundary carry transition metadata `{ point: "task_outcome", direction:
"vm->host" }` with source-function fallback. VX reports task-observer failures
through the `commands` error phase and retained-mapper failures through the
existing dispatch path, while releasing owned retained handlers exactly once.

## V-484 — Compiler-derived MessagePack boundary codecs

`std::msgpack::pack_boundary_value<T>` and `unpack_boundary_value<T>` are the
typed MessagePack codec surface. The compiler derives codecs for closed
boundary-compatible primitives, records, arrays, optional fields, and named
enum or union variants with payloads. No per-type generated symbol is added to
the source API.

Record keys use the exact declared source spelling. MessagePack maps are
semantically unordered, so key order is not part of the wire contract; encoding
remains deterministic for a given closed schema and value, and consumers resolve
fields by name. Arrays retain element order, absent optional fields are omitted,
and named variants encode as a map with `$variant` set to the declared variant
name plus sibling payload fields. Variant payload fields named `tag` or
`$variant`, and unions whose variants would share the same discriminator, are
rejected as ambiguous. Renaming a field or variant is therefore a wire-schema
change; there is no implicit renaming policy.

Versioning is opt-in through an ordinary explicit `version` field in the DTO.
The compiler neither injects version tags nor performs migrations. This keeps
the encoded map inspectable and makes version dispatch an application-owned
decision. Unsupported or ambiguous shapes produce a compile diagnostic at the
codec call with the nested field path.

Generated `MsgPack` values remain compatible with
`@boundary(type: "payload", field: "payload")` envelopes. VX Canvas gradients,
path segments, draw/state operations, and version-2 frames now use private typed
wire records instead of handwritten maps while preserving their existing host
payloads. `CanvasPathSegment`, `CanvasDraw`, and `CanvasRadialGradient` keep an
optional object-private typed cache so composition does not decode and re-encode
values created by their constructors; host-originated payload envelopes leave
that cache absent and are decoded when composed.

This cache makes those three nominal wrappers constructor-only outside the
standard-library package: external Voyd code can read `payload` but can no
longer construct the wrappers with raw object literals. Their typed public
constructors are the supported source API, while serialized host inputs remain
wire-compatible. This intentional source-level restriction is included here for
explicit API review.

Web query extraction uses the declared record shape to coerce URL query scalars
before invoking the strict derived MessagePack decoder. String fields preserve
their exact source text; boolean and numeric fields accept only valid values for
their declared type and range. Missing required fields, malformed values,
overflow, and non-record targets produce a `400` response. This keeps coercion
at the HTTP adapter boundary without weakening the codec contract.

## V-485 — Strict typed JSON decoding

`std::json::decode<T>` derives a closed structural decoder from `T` for records,
arrays, optional fields, primitives, and tagged unions. It accepts owned text,
borrowed text, or a parsed `JsonValue`. Decoding is strict by default; callers
may opt into `permissive_decode_options()` to ignore unknown fields. Failures use
`JsonDecodeError { kind, path, message }`, retain the parse or shape reason, and
report rooted paths such as `$.profiles[1].age`.

Union payloads use an inspectable object with a `$variant` discriminator;
payload-free variants may also use their variant name as a JSON string.
`decode_versioned<T>` reads the required integer `version`, invokes an explicit
migration callback only for non-current versions, and verifies that a successful
migration produced the requested version. It accepts text or an already-parsed
value. `number_in_range` supplies an inclusive numeric constraint while
preserving a caller-provided path.

Orbit's v1 simulation, summary, and API-error readers now decode private typed
wire records whose camel-case field names exactly preserve the existing readable
JSON contract. Simulation readers return `JsonDecodeError`, reject unknown
versions and fields, and never replace missing or mistyped nested values with
defaults. Encoding remains unchanged.

## V-486 — Hygienic macro identifiers

Identifier syntax carries a compilation-only lexical context independent of its
readable spelling. Surface and spliced identifiers retain caller context,
template literals use the macro definition context, and `identifier` allocations
use deterministic expansion and allocation identities. This context and macro
provenance are omitted from serialized AST and public metadata.

`identifier("debug_label")` allocates a fresh binding on every call. The operand
may also be identifier syntax; that overload copies only its readable spelling
as the debug label and never reuses its identity. This supports syntax-driven
name transformations such as enum expansion without creating an
intentional-capture API. Equal labels remain distinct, and a macro reuses the
returned syntax when one generated binding needs declaration and reference
occurrences. Fresh declarations remain private even when expansion visibility
is public, so diagnostic labels cannot become exported API names. A grouped
`pub use` containing a fresh alias is downgraded to module visibility. Because
effect operations and trait requirements are implicitly visible through their
owner, a public effect or trait containing a fresh member is likewise downgraded
to module visibility. There is no raw or unhygienic escape hatch.

`symbol_reference(symbol)` accepts an identifier or qualified symbol, rejects
strings and declaration use, and resolves the existing value, type, trait, or
effect without caller fallback. A cross-module private target becomes a hidden
implementation and link dependency rather than a public import.

Generated-syntax diagnostics use the invocation as the primary location and may
attach the macro definition as related context. Language-server navigation and
rename index generated declarations and references at visible macro-definition
syntax while retaining a distinct binding identity for each invocation.

Compiler-inserted JSX helpers and empty-child type dependencies resolve through
explicit standard-library identities; component and user syntax remains
caller-scoped. Enum variants use private fresh symbols, while the public enum
namespace separately exposes each natural variant spelling. Unrelated enums may
therefore reuse names without a module-level collision.

## V-487 — Atomic filesystem persistence and portable errors

`std::fs` adds overloaded `write_atomic(path, contents)` and
`create_exclusive(path, contents)` functions for `Bytes`, `String`, and
`StringSlice`. `write_atomic` writes an exclusively created temporary in the
destination directory and renames it only after the full payload is written.
Readers therefore see the previous complete file or the replacement; the API
does not claim crash durability or an implicit directory `fsync`.
`create_exclusive` admits exactly one creator and reports an existing path as a
structured error.

`IoError` adds `kind: IoErrorKind` with `IoNotFound`, `IoAlreadyExists`,
`IoPermissionDenied`, `IoConflict`, and `IoOther` variants. Default filesystem
adapters categorize Node and Deno failures portably while retaining the native
numeric code and message. Payloads from older/custom hosts that omit `kind`
decode as `IoOther`. Orbit exposes stable repository categories
`storage-not-found`, `storage-conflict`, `storage-permission-denied`, and
`storage-failed` and treats all storage failures as server errors.

## V-488 — UTC timestamps

`SystemTime::from_unix_millis` constructs a timestamp without a host effect.
`parse_rfc3339` accepts `String` and `StringSlice`; it accepts explicit UTC
offsets, normalizes to UTC, supports at most millisecond precision, and rejects
leap seconds and malformed or out-of-range dates. `to_rfc3339` emits canonical
UTC text with a fixed three-digit millisecond field and supports years
`0000...9999`. Failures use `TimestampError { code, index, message }` so callers
can distinguish syntax, range, precision, overflow, and formatting failures.

## V-489 — Locale-independent number formatting

`std::number::cast` adds overloaded `format_fixed`, `format_significant`, and
`format_scientific` functions for `f64` and `f32`. Precision is explicit,
rounding uses ties-to-even, trailing fractional zero trimming is configurable,
and negative zero is normalized. `format_significant` uses fixed notation for
decimal exponents `-6...20` and scientific notation outside that range.
`NonFinitePolicy::symbols` renders `NaN`, `Infinity`, and `-Infinity`, while
`NonFinitePolicy::reject` returns `NumberFormatError`. Formatting is deliberately
locale-independent and performs no grouping.

## V-490 — Secure bytes and UUIDs

`secure_bytes(len)` validates that the host returns exactly the requested byte
count with integer values in `0...255`; malformed host payloads return
`RandomError` and are never normalized or replaced with an insecure fallback.
`Uuid::v4()` sources 16 secure bytes, sets RFC 4122 version/variant bits, and
renders canonical lower-case `8-4-4-4-12` text. `Uuid::parse` accepts canonical
upper- or lower-case hexadecimal input, while `Uuid::is_valid` and `to_string`
provide validation and canonicalization. Owned and borrowed string overloads
have equivalent behavior.

## V-491 — Source-aware approximate assertions

`assert_close` is overloaded for `f64` and `f32` and accepts absolute tolerance,
relative tolerance, and an optional context message. A value passes when its
absolute delta is within `max(absolute, relative * max(abs(actual),
abs(expected)))`. Equal infinities and signed zeros pass; NaN and invalid
tolerances fail. Defaults are `1e-12` absolute / `1e-9` relative for `f64` and
`1e-5` for both tolerances for `f32`.

The public helper lives in `std::test::numeric`; the dependency-light
`std::test::assertions` module remains suitable for foundational standard-library
tests. Its stable `Test` effect adds the low-level
`fail_with(pointer: i32, byte_len: i32)` operation beside `fail()`. Numeric
assertions encode a UTF-8 diagnostic in Wasm memory, and SDK/CLI handlers decode
that transport before surfacing expected/actual/delta/tolerance details with the
test declaration's source location. Application tests should call
`assert_close`, not the transport operation. Adding the operation intentionally
requires exhaustive closed handlers of `voyd.std.test.assertions` to account for
it.

## V-492 — Multiline expressions and constructor diagnostics

An indented line after a continuation operator remains part of that expression.
This applies consistently to boolean and arithmetic operators, so formatting a
right-hand operand on the following line does not turn it into a call-shaped
child block. Existing block indentation and same-line precedence are unchanged.

When type-call constructor sugar fails for a type that declares `init`, the
diagnostic points at the type spelling and names the explicit
`Type::init(...)` alternative. The sugar remains supported when its arguments
match; the explicit spelling is diagnostic guidance, not a new construction
rule.

## V-493 — Tag-aware JSX form properties

Built-in JSX assigns form syntax according to the HTML tag. `value` produces a
live property on `input` and `textarea`, and an ordinary attribute on `button`,
`data`, `li`, `meter`, `option`, `param`, and `progress`. `checked` is a property
only on `input`; `disabled` is a property on `button`, `fieldset`, `input`,
`optgroup`, `option`, `select`, and `textarea`. Unsupported combinations fail at
the attribute's source range before rendering and name the property, tag, and a
stable alternative where one exists. In particular, `value` on `select`
suggests `selected` on the matching option.

The explicit lower-level `prop` helper continues to support browser-only views.
Server rendering rejects any property/tag combination without a stable HTML
representation. Browser hydration and server rendering share one runtime
representation contract for supported properties, including textarea text
content. Orbit's scenario picker now uses typed
`<option value={...} selected={...}>` syntax.

## V-494 — Module and package boundary policy

Voyd keeps its existing visibility model and adds one deliberate compatibility
break: an ordinary `foo.voyd` and nested `foo/pkg.voyd` may not coexist because
both own the logical path `foo`. Compilation now reports both files and chooses
neither. A nested package root remains physically named `pkg.voyd` but is
imported as `src::foo`; no new path or visibility syntax is introduced.

An ordinary module facade remains an organizational boundary inside its package.
Unmodified top-level declarations are module-private, `pub` in ordinary modules
is package-visible, and public declarations or re-exports in `pkg.voyd` form the
external package surface. A nested package's parent is an external consumer of
that boundary. Default members retain same-package access, `pri` remains
owner-only, and `api` admits cross-package field or method access only when the
owning type is exported.

`module::all` remains a one-level selection of the exported symbol table. It
includes exported values, functions and overloads, types, traits, effects,
macros, and top-level operator symbols. It does not recursively flatten child
modules, import instance members as free names, or flatten effect operations;
operations continue to use `Effect::all` or an explicit effect-namespace
selection. Top-level operators must be selected explicitly or through `all`.
An `api` operator in an `impl` follows its exported owner. Canonical symbol
identity plus overload, operator, trait-implementation, macro, and generated
declaration metadata survives package-root re-exports.

Boundary diagnostics now distinguish missing modules and exports,
module-private declarations, package-private declarations, non-`api` external
members, unexported macros, omitted operator or trait-implementation imports,
hidden nested internals, and the conflicting file pair. Messages name the
relevant declaration or package-root file, identify the package transition, and
recommend the smallest valid change. Orbit adopts `shared/pkg.voyd`,
`simulation/pkg.voyd`, `client/pkg.voyd`, and `server/pkg.voyd`; logical imports
remain unchanged, and `client/pkg.voyd` is the browser program entrypoint.

## V-495 — Identity-based qualified effect operations

Voyd keeps `Effect::operation(...)` as the operation-call spelling; no `perform`
keyword is added. A qualified name resolves its qualifier first. An effect or
effect alias searches only that effect's operation table, while a module searches
only ordinary module exports. There is no lexical, module, static-method, trait,
general-overload, or unqualified same-name fallback between these paths. This
allows the canonical pairing `use std::fs` / `fs::rename(...)` for a typed wrapper
and `use std::fs::Fs` / `Fs::rename(...)` for the raw operation and handler.

An operation's public identity is its declaring effect plus its declaration
symbol. Effect aliases preserve that identity, and calls and handler clauses
record and match the same exact pair. Operation names must be unique within one
effect; effect operations do not overload. A duplicate declaration diagnoses the
second declaration and points to the first. An ordinary function with the same
spelling remains an independent declaration.

Explicit unqualified selection remains supported through
`use Effect::operation`, `use Effect::operation as alias`, grouped selections,
and `use Effect::all`. If the selected name collides with an ordinary function,
the compiler diagnoses the collision and suggests either qualification or an
alias; it never merges the declarations into an overload set. Ordinary
`module::all` and implicit module-member selection exclude effect operations. An
explicit operation re-export may be selected later as an unqualified import, but
it does not become a valid `module::operation(...)` call.

Effect operations are not first-class values. A bare designator such as
`let op = Fs::rename` is rejected; qualified operation designators are supported
only by calls, handler clauses, imports, re-exports, and tooling. Handler
qualifiers must resolve to an effect, and their first binder uses the declared
`tail` or `resume` mode. Diagnostics separately identify a non-effect qualifier,
a missing operation, an import collision, a duplicate operation, a bare
designator, and an ordinary function used as a handler.

Language-server completion follows the same namespace split. Hover reports the
declaring effect, stable effect ID, signature, continuation mode, source module,
and any local alias; go-to-definition and rename retain canonical operation
identity without including a same-named wrapper.

## V-496 — Effect-test ownership guidance

The borrow rules and callable surface are unchanged. Diagnostics for an escaping
mutable borrow now direct effect handlers to create an owned snapshot before
`tail`/`resume`, keep fixed response fixtures immutable, and use
`SharedCell<T>` for observations that genuinely change. A `SharedCell` callback
must finish before invoking the continuation. The documented mock-host pattern
keeps responses as ordinary values and confines captured writes or counters to
short `with`/`with_mut` callbacks; it does not weaken continuation ownership or
borrow checking.

## V-497 — Composable effect-handler policy

No fallback-clause syntax is added. Reusable ordinary `with_*` functions own a
closed, exhaustive outer handler, while an inner `try open` may override selected
operations and forward the rest to that outer policy. Every operation keeps its
declared continuation result type; there is no type erasure, implicit selection
by result type, or dynamic fallback continuation. Adding an operation to an
effect continues to make closed outer handlers fail compilation until they
choose explicit typed behavior. Public naming guidance favors policy-bearing
names such as `with_fixture_console` or `with_read_only_files` when multiple
handling behaviors exist.

## V-498 — VX Canvas v2 interaction surface

`CanvasPathSegment` has typed constructors for moves, lines, quadratic and
cubic Bézier curves, arcs, tangent arcs, ellipses, rectangles, and closing a
subpath. `CanvasTransform`, balanced save/restore, matrix/translate/rotate/scale,
line dashes, `CanvasFillRule`, and the standard Canvas compositing operations are
also public. State operations remain ordered `CanvasDraw` values, preserving the
existing frame builder while making host execution deterministic.

`CanvasTextMetrics` and
`Cmd::canvas_measure_text(selector: value: font: handler:)` model browser
measurement as an asynchronous VX command/result. The typed handler follows
normal command ownership: Voyd retains it and the browser releases it after the
result is dispatched.

`EventOptions.pointer_capture`, `MouseEvent.pointer_id`, and pointer-cancel
helpers complete pointer interaction. The browser captures an opted-in pointer
on `pointerdown` and releases it on `pointerup` or `pointercancel`. Orbit stores
the active pointer ID and ignores move, release, and cancellation events from
other pointers.

Applications draw and receive text metrics in logical CSS pixels; the browser
owns device-pixel-ratio backing-store scaling. `canvas_frame` emits version 2
because paths and ordered state operations break the version-1 draw grammar.
The new host continues to validate and render legacy version-1 primitives while
accepting the expanded grammar only in version 2. Additive optional fields may
remain within a version; another breaking change increments it. Unsupported,
malformed, or unbalanced frames are rejected before the target Canvas is
resized or painted.
