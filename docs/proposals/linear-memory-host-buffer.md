# Linear Memory Host Buffer Ownership

Status: draft
Owner: Runtime + Stdlib
Scope: `packages/std/src`, `packages/js-host/src`, `docs/proposals/msgpack-interop.md`

## Problem

The effects host boundary uses a MsgPack buffer in the default linear memory
export (`memory`). Today the host assumes ownership of a buffer region, but
this is not explicitly documented and user code can accidentally overwrite it.
We need a clear contract for buffer ownership and safe access to linear memory.

## Goals

- Make buffer ownership explicit and discoverable.
- Prevent accidental overwrites by user code.
- Keep the host boundary ABI stable and simple.
- Provide a safe memory API for user code.

## Non-Goals

- Introducing a third memory for MsgPack.
- Changing the effects table memory (`effects_memory` remains separate).

## Proposal (Phased)

### Phase 1 — Document the Reserved Buffer Region

- Document that the host owns a reserved range in `memory` used for MsgPack
  payloads (effect requests/resumes and serialized exports).
- Document that user code must not write into the reserved buffer region.
- Document the current default assumption: buffer base is `0` and size is
  `bufferSize` (host configurable).

### Phase 2 — Provide a Simple Allocator in Std

- Add a minimal bump allocator in `std::memory` (or a small `std::alloc` module)
  that hands out regions outside the reserved buffer range.
- Expose:
  - `alloc(size: i32) -> i32`
  - `reset()` or `free_all()` for scratch usage
- Keep it explicitly opt-in; no GC or automatic tracking.

### Phase 3 — Make Buffer Base/Size Visible to User Code

- Expose the host buffer base/size to Wasm via:
  - exported globals (e.g. `msgpack_buffer_ptr`, `msgpack_buffer_len`), or
  - a small custom section parsed by tooling, or
  - a dedicated getter export (`get_msgpack_buffer_info`) if we want a function.
- Allow the host to choose a non-zero buffer base without breaking user code.
- Update docs to recommend user allocations avoid the reserved buffer range
  using the exposed base/size.

## Implementation Notes

- Keep `effects_memory` separate. It is a fixed handle table and should remain
  isolated to prevent accidental corruption.
- MsgPack payloads continue to use the default `memory` to match standard WASM
  expectations and avoid additional host import complexity.

## Success Criteria

- The docs clearly state the reserved region and ownership rules.
- A bump allocator is available in std for safe user allocations.
- The host buffer base/size are discoverable by user code and tooling.

## Open Questions

- Preferred exposure mechanism (globals vs custom section vs export).
- Should `bufferSize` have a minimum enforced by the host/stdlib?
