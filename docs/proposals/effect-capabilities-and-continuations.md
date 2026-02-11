# Effect Capabilities and Continuation Instance Keying

Status: Implemented
Owner: Compiler + Runtime
Scope: effects codegen, host ABI, runtime ABI

## Summary

This proposal addresses two release blockers:

- Continuation functions are keyed by symbol name, so generic instantiations in
  the same module can reuse the wrong WASM signature.
- Effect resolution is based on fragile names and module paths, so the host
  binding can silently drift on renames or relocation.

We introduce stable effect descriptors and a host-provided capability table,
plus instance-aware continuation keying and validation. The end state is a
stable, release-ready ABI.

See `docs/specs/host-protocol.md` for the wire format and ABI details.

## Goals

- Continuation functions are keyed by function instance, not just symbol.
- Effect resolution is stable under renames and module relocation.
- Host dispatch uses opaque capability handles rather than names.
- ABI is versioned and validated to allow public release.

## Non-Goals

- Preserve the current host ABI unchanged.
- Guarantee backwards compatibility with existing host runners.

## Proposal

### 1) Effect Descriptor Table (stable IDs)

Extend the effect table export (or add a custom section) to emit a stable
descriptor list:

- `op_index`: stable index for each op in the module table.
- `effect_id`: stable identifier (string or 64-bit hash).
- `op_id`: numeric op identifier within `effect_id`.
- `resume_kind`: resume/abort semantics.
- `signature_hash`: hash of param/result types.
- `abi_version`: effect ABI version.

**Effect ID stability**

- Public release requirement: `@effect(id: "com.example.log")` (or similar)
  must be provided for every public effect declaration.
- Fallback for internal code: hash of package + module path + effect name.
  The compiler should warn when no explicit id is supplied.

### 2) Capability Handles (host-driven dispatch)

The host owns effect handlers. The module only needs opaque handles.

**Handshake**

1. Module exports `__voyd_effect_table` (descriptor list).
2. Host reads the table and chooses a handler for each `effect_id + op_id`,
   validating `signature_hash` and `abi_version`.
3. Host allocates an opaque handle for each op (u32 or pointer-like index).
4. Host writes handles to the reserved effect handle table in `op_index` order.
5. Host calls `init_effects(handle_table_ptr)` to signal that the table is
   ready and provide its base pointer.

**Module behavior**

- `init_effects` is compiler-emitted (not user-defined) and points at the
  reserved effect handle table.
- `perform` lowers to:
  - constant `op_index`
  - load handle from the table
  - build request including the handle (and optionally `op_index` for debug)

**Host dispatch**

- The host dispatch loop uses only the handle in the request to route to a
  handler. No name-based resolution is involved.

This is the key mechanism that connects `Log::info` to a host handler: the
host reads the effect table entry for `Log.info`, assigns a handle, and the
module uses that handle whenever it performs the op.

### 2.2) Handle Table Location

Effect handles are stored in linear memory at a host-selected base pointer.

- The host writes a `u32` handle table into `memory` and passes
  `handle_table_ptr` to `init_effects(handle_table_ptr)`.
- MsgPack buffers and the handle table share linear memory but use disjoint
  regions chosen by the host runtime.
- The module may additionally export `effects_memory` as a compatibility alias
  to `memory`.
- Hosts may grow `memory` if buffers or handle tables exceed capacity.

### 2.1) Generics

**Generic effect operations**

- Generic effect ops are monomorphized at compile time.
- Each concrete instantiation receives a distinct `op_index` entry in the
  descriptor table, even if it shares the same `effect_id` and `op_id`.
- The descriptor entry includes a `signature_hash` so the host can distinguish
  instantiations and validate ABI compatibility.
- The module always performs by `op_index`, which maps to the correct handle.

**Generic effectful functions (continuations)**

- Continuation functions are keyed by `ProgramFunctionInstanceId` so each
  instantiation emits a unique continuation function name and signature.
- Any attempt to reuse a continuation key with a different signature is a
  hard diagnostic.

### 3) Continuation Instance Keying

Continuation functions must be keyed by function instance, not symbol:

- Introduce `ContinuationKey = base_name + instance_id + owner_kind`.
- Continuation WASM names include the instance id suffix (e.g. `__inst42`).
- Replace `ContinuationSite.contRefType` with a cache keyed by
  `ContinuationKey`.
- Keep `contCfgByName` keyed by base name (shared across instances).
- Add a signature guard: if the same `ContinuationKey` is generated with a
  different signature, throw a diagnostic.

### 4) ABI Versioning and Validation

- Add a `effect_abi_version` constant to the descriptor table.
- Host validates `abi_version` and `signature_hash`.
- Mismatches are hard errors; no silent fallback.

## Implementation Plan

1. **Descriptor table extension**
   - Extend `__voyd_effect_table` (or add custom section) with stable ids and
     signature hashes.
2. **Effect id annotations**
   - Add parsing + HIR metadata for `@effect(id: "...")`.
3. **Host capability mapping**
   - Update host runner to map `effect_id + op_id` to handlers and call
     `init_effects`.
4. **Lowering change**
   - Emit `op_index`-based handle lookup and include handle in effect requests.
5. **Continuation instance keying**
   - Implement `ContinuationKey` and update caches to be instance-aware.
6. **Diagnostics**
   - Error on signature mismatch or missing handle table.
7. **Tests**
   - e2e: generic effectful function instantiated with two type args in a
     module should produce two distinct continuation functions.
   - e2e: same effect id across renames resolves to the same host handler.
   - ABI: signature hash mismatch fails fast.
8. **Update existing effects**
   - Require all current effect users to conform to the new protocol.
   - Update `apps/cli/src/test-runner.ts` to use the JS host once available.

## Success Criteria

- No name-based effect resolution remains in host integrations.
- All existing effect callers (notably `apps/cli/src/test-runner.ts`) are
  updated to the new protocol.

## Refactor Direction

Introduce two focused registries for maintainability:

- `EffectInstanceRegistry`: owns stable ids, op indices, signature hashes, and
  handle table layout.
- `ContinuationRegistry`: owns continuation keying, ref-type caches, and
  signature validation.

This consolidates currently scattered naming/caching logic and reduces the
risk of future regressions.
