# MsgPack Interop Implementation Plan

## Phase 1 — Stdlib + Compiler Plumbing (complete on this branch)
- `packages/std/src/memory.voyd` intrinsics added.
- `std::msgpack` implemented and `@serializer("msgpack", encode_value, decode_value)` applied.
- `@serializer` attribute handled in parsing/binding/typing.
- Serializer metadata surfaced in codegen view.
- Export ABI metadata (`voyd.export_abi`) emitted.

Success criteria (met):
- `std::msgpack::MsgPack` is serializer-marked and loads without new diagnostics.
- `voyd.export_abi` is emitted for modules with exports.
- Tests pass: `npm test`.

## Phase 2 — Serialized Export ABI + Host Support (complete on this branch)
- Serialized export ABI lowering implemented.
- Single-serializer-per-export enforced.
- `@voyd/js-host` reads `voyd.export_abi` and dispatches direct vs serialized calls.
- SDK export ABI metadata schema updated.
- Serialized export tests added.

Success criteria (met):
- MsgPack-typed pure exports can be invoked from JS with complex args/returns.
- Direct-ABI exports still work unchanged.
- Tests pass: `npm test`.

## Phase 3 — Finalization + Docs (remaining)
- Update effect signature hashing to include serializer-marked types (add a targeted test).
- Document the canonical `voyd.export_abi` JSON schema (version + export entries).
- Document enum/union mapping strategy for serializer derivations (tagged map).
- Refresh `docs/proposals/msgpack-interop.md` to match current implementation (remove legacy `__voyd_msgpack_*` references, call out effect payload format and resume ABI).

Success criteria:
- Effect handlers receive/return complex values via MsgPack (arrays/maps/objects).
- `voyd.export_abi` schema documented and referenced by SDK/host docs.
- Expanded test coverage: e2e host round-trip of complex types + msgpack stdlib unit tests for encode/decode.
- Tests pass: `npm test`.
