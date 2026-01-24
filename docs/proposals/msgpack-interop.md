# MsgPack Host Interop and Std Module

Status: in progress
Owner: Runtime + Stdlib
Scope: `packages/std/src`, `packages/compiler/src`, `packages/sdk/src/shared/types.ts`, `packages/js-host/src`

## Goal

Provide a first-class, maintainable way to exchange complex data structures
between Voyd and host runtimes using MsgPack. The solution must work with the
new compiler pipeline and integrate cleanly with the existing effects host
boundary.

## Current State

- Legacy stdlib has `packages/std/src_legacy/msg_pack` with a hand-rolled
  encoder/decoder that writes directly to linear memory.
- The new compiler uses MsgPack for effectful host boundary payloads via host
  imports (`__voyd_msgpack_write_value`, `__voyd_msgpack_write_effect`,
  `__voyd_msgpack_read_value`), but only supports primitive values.
- Effectful exports reject non-primitive return types in
  `packages/compiler/src/codegen/functions.ts`.
- There is no standard library module in `packages/std/src` for MsgPack or
  linear memory access.
- `@voyd/js-host` has `run`, `runPure`, and `runEffectful`, but no way to call
  pure exports with complex args/returns.

## Proposal

### 1) Linear Memory Access API (Std + Compiler)

Introduce a small, explicit memory module as the foundation for MsgPack.

`packages/std/src/memory.voyd` (new):

- `size() -> i32`, `grow(pages: i32) -> i32`
- `load_u8(ptr: i32) -> i32`
- `store_u8(ptr: i32, value: i32) -> void`
- Optional helpers: `load_u16`, `load_u32`, `store_u16`, `store_u32`,
  `copy(dest, src, len)`

Compiler support:

- Add new intrinsics in `packages/compiler/src/codegen/intrinsics.ts` that map
  to Wasm memory ops (store8, load8_u, memory.grow, memory.size, memory.copy).
- Keep the API intentionally small so `std::msgpack` is the only consumer at
  first.

Rationale: MsgPack needs byte-level writes/reads. This keeps memory access
explicit, testable, and contained to a single stdlib module.

### 2) `std::msgpack` Module (New)

Create a new standard module under `packages/std/src/msgpack` with a canonical
recursive data type that is the required host boundary shape.

Proposed definitions (unions must be made up of objects, so scalars are boxed):

```
// std::box
pub obj Box<T> { value: T }

pub type Numeric = i32 | i64 | f32 | f64

pub obj Null {}
pub obj Binary { bytes: Array<i32> }

pub type MsgPack =
  Null
  | Box<Numeric>
  | Box<bool>
  | Box<String>
  | Binary
  | Array<MsgPack>
  | Map<MsgPack>
```

Notes:

- This is the required return/arg type for msgpack interop. If you need to
  send complex values, you must convert them into `MsgPack` first.
- We keep keys as `String` for host interop determinism; allow other key types
  only if we add a stable, explicit mapping.

Encoder/decoder for the canonical type:

- `encode_value(value: MsgPack, ptr: i32, len: i32) -> i32` (returns bytes)
- `decode_value(ptr: i32, len: i32) -> MsgPack`

Phase 2 (optional, compiler-driven):

- Add derive/attribute helpers that generate per-type codecs and attach them
  via `@serializer(format_id, encode_T, decode_T)` (no implicit encoding for arbitrary
  non-primitive types).
- Supported mappings (bikeshedable):
  - `Option<T>` => `null` or encoded value
  - tuples => msgpack arrays
  - structs/objects => msgpack maps with field names
  - enums/unions => tagged map `{ tag, value }`

This keeps a manual path (`MsgPack`) while enabling a long-term ergonomic path
for structured types when explicitly opted into.

### 3) Type-Level Serialization (`@serializer`) and Export ABI

Introduce an explicit, type-directed mechanism that leaves room for future
formats while only opting into decoding when a MsgPack boundary type is used.

New compiler attribute (proposed):

- `@serializer(format_id, encode_fn, decode_fn)` applied to a type declaration.
- `format_id` is a stable identifier (e.g. `"msgpack"`) used to prevent
  cross-format mismatches.
- `encode_fn` shape: `fn (value: T, out_ptr: i32, out_len: i32) -> i32` (bytes written, or < 0)
- `decode_fn` shape: `fn (ptr: i32, len: i32) -> T`
- The compiler treats a type with `@serializer` as *host-serializable*.

Initial scope: apply `@serializer("msgpack", ...)` only to `std::msgpack::MsgPack`.

- This makes host serialization an explicit choice in function signatures:
  - `pub fn main() -> MsgPack` is host-callable via serialization.
  - `pub fn main() -> Foo` errors unless `Foo` is directly host-callable.
- Future serialization formats add their own boundary types and serializers
  without changing the compiler architecture.

Export ABI (pure functions):

- Keep the direct ABI for exports whose parameters/return are all directly
  host-callable (i32/i64/f32/f64/none).
- If any parameter or the return type is `@serializer`-annotated, export a
  *serialized ABI* under the original export name (no `*_msgpack` wrapper):
  - `entry(args_ptr: i32, args_len: i32, out_ptr: i32, out_len: i32) -> i32`
  - `args_ptr/args_len` holds a single encoded value using the export’s serializer
    `format_id` (recommended: array of args).
  - Return value is written to `out_ptr/out_len`; the function returns bytes written.

Note: if an export signature contains any serializer-marked type, the whole call
uses the serialized ABI. Directly host-callable parameters are encoded as scalar
values alongside serializer types in the same args array. Exports must not mix
different serializer `format_id`s in a single signature.

Host behavior:

- `@voyd/js-host` reads a small custom section (e.g. `voyd.export_abi`) that
  declares, per export, whether it uses the direct ABI or the serialized ABI
  (and the serializer `format_id`).
- `run` chooses the right call path based on that metadata.

Example (pure export):

```voyd
pub fn echo(value: MsgPack) -> MsgPack { value }
```

### 4) Effects Integration (Single-Step, MsgPack-Clean)

Effects already rely on MsgPack buffers; we should align with the stdlib
encoder to support complex effect args and return values.

Single-step design (breaking change):

- Encode/decode effect payloads in Wasm via `std::msgpack`, so host handlers can
  receive and return complex data without the host needing to understand Wasm
  runtime layouts.
- Make effect payloads a single MsgPack message written by Wasm into the
  provided buffer; the host only decodes/encodes bytes.
- Add payload length to the effect result so the host can decode exactly what
  Wasm wrote (no implicit “latest length” state).

Why this is necessary:

- The existing host boundary imports can only encode/decode primitives because
  the host cannot introspect arbitrary Wasm data layouts. Supporting complex
  values therefore requires Wasm-side serialization.
- This change makes the current MsgPack host imports (`__voyd_msgpack_*`)
  redundant; they can be removed once the Wasm-side payload path is in place.

Proposed runtime shape:

- Effect entrypoints keep the existing `(buf_ptr: i32, buf_cap: i32)` pattern.
- The returned `effect_result` is extended to include `payload_len: i32`.
  - Add a new accessor export: `effect_len(result) -> i32`.
- `resume_effectful` is updated to accept the resume payload length (breaking):
  - `resume_effectful(cont, buf_ptr: i32, resume_len: i32, buf_cap: i32) -> effect_result`

Payload schema (written by Wasm, read by host):

- Value outcome: `<encoded return value bytes>` (no envelope; use `effect_status` to decide how to decode).
- Effect request: `{ effectId, opId, opIndex, resumeKind, handle, args }`
  - `args` is the logical argument list, encoded as MsgPack (arrays/maps/etc).
  - Complex values are represented by using `std::msgpack::MsgPack` in the
    effect signature; the compiler only decodes to `MsgPack` when that type is used.

Notes on effect signatures:

- Effect table signature hashing should incorporate serializer-marked types so
  handler lookup remains sound across ABI changes.

Notes:

- `effects_memory` remains a dedicated memory for handle tables.
- MsgPack buffers continue to use the default linear memory export (`memory`).
- Buffer overflow stays a hard error (trap or non-zero status).

### 5) Memory Strategy

Do not add a dedicated MsgPack memory. Continue using the default linear
memory export:

- The host already grows and owns the buffer for effectful entrypoints.
- Introducing a third memory adds complexity across toolchains and imports.
- Keep the buffer pointer explicit; do not assume address 0 for stdlib calls.

If we need multiple buffers, define explicit pointer conventions (input/output)
or allocate via a simple bump allocator in `std::msgpack` (future work).

## Required Changes (By Area)

### `packages/std/src`

- Add `memory.voyd` with intrinsic wrappers.
- Add `msgpack/*` module with encoder/decoder.
- Apply `@serializer("msgpack", std::msgpack::encode_value, std::msgpack::decode_value)`
  to the canonical `MsgPack` type.

### `packages/compiler/src`

- Implement memory intrinsics in `codegen/intrinsics.ts`.
- Implement `@serializer` on types and surface it in codegen metadata.
- Emit the serialized export ABI for exports that use serializer-marked types.
- Extend effects codegen to encode/decode via `std::msgpack` and add `effect_len`.

### `packages/sdk/src/shared/types.ts`

- Document and type the `voyd.export_abi` metadata (direct vs serialized exports).
- Update `run` to choose ABI via metadata instead of naming conventions.

### `packages/js-host/src`

- Read `voyd.export_abi` and call either the direct or serialized export ABI.
- Update effect dispatch to:
  - decode payloads using `effect_len(result)`,
  - resume via `resume_effectful(cont, buf_ptr, resume_len, buf_cap)`.

## Success Criteria

- A pure export returning a complex object can be called from JS via `run`
  when the signature opts into `MsgPack` explicitly.
- Host-side effect handlers can accept and return complex values (arrays/maps/objects)
  via MsgPack without special-case wrappers.
- No new linear memory is required; `memory` remains the MsgPack buffer.
- The stdlib encoder/decoder is reusable for both host boundary and user code.

## Open Questions

- What should the `voyd.export_abi` section format be (JSON vs MsgPack vs a
  small binary table)?
- Should `format_id` be a string, number, or interned symbol?
- What is the canonical mapping for enums/unions (tagged map vs tuple)?

## Refactor Direction

`packages/compiler/src/codegen/effects/host-runner.ts` and
`packages/js-host/src/runtime/dispatch.ts` duplicate msgpack host logic. Once
MsgPack stdlib encoding is in place, consider extracting shared helpers or
dropping the compiler test host in favor of `@voyd/js-host`.
