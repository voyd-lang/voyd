# Voyd Host Protocol

Status: Draft  
Owner: Runtime + Host Integrations  
Scope: host <-> wasm integration for effectful modules

## Overview

This document defines the stable protocol between a Voyd WASM module and a host
runtime. The protocol is designed to be host-language agnostic (JS, Rust, etc.)
and supports capability-based effect dispatch, stable effect IDs, and generic
instantiations.

See `docs/proposals/effect-capabilities-and-continuations.md` for the overall
design and compiler changes.

## Goals

- Stable, rename-safe effect binding for public modules.
- Deterministic mapping for generic instantiations.
- Explicit ABI versioning and validation.
- Host dispatch via opaque handles (capabilities).

## Terminology

- **Effect ID**: Stable identifier for an effect (string or hash).
- **Op ID**: Numeric identifier within an effect.
- **Op Index**: Global, deterministic index of an op entry in the table.
- **Signature Hash**: Hash of op parameter and result types (concrete types).
- **Handle**: Opaque host-provided capability used for dispatch.

## Required Module Exports

Effectful modules must export:

- `__voyd_effect_table` (custom section): effect descriptors and op entries.
- `memory_effects` (Wasm memory): dedicated effect handle memory, compiler-emitted
  and exported by the module.
- `init_effects()`:
  - compiler-emitted function that marks the handle table as ready.
- `resume_effectful(request: anyref, buf_ptr: i32, buf_len: i32)`:
  - resumes execution after an effect is handled.
- `effect_status(result: anyref) -> i32`:
  - returns 0 for value, 1 for effect.
- `effect_cont(result: anyref) -> anyref`:
  - returns the continuation/request payload when `effect_status` is 1.

## Effect Table (Version 2)

The custom section encodes a deterministic, per-program list of effect ops.
Table version 2 adds stable IDs and signature hashes.

### Logical Fields (per op entry)

- `op_index`: global index across all ops (implicit by order).
- `effect_id`: stable id (string) or 64-bit hash.
- `op_id`: numeric op id within the effect.
- `resume_kind`: resume or tail.
- `signature_hash`: hash of the concrete op signature.
- `label`: debug label (optional).

### Deterministic Ordering

`op_index` is defined by sorting entries by:

1. `effect_id`
2. `op_id`
3. `signature_hash`

This ordering is stable across modules and compilers.

### Generic Instantiations

Generic ops are monomorphized at compile time. Each concrete instantiation
generates a distinct op entry with the same `effect_id` + `op_id` but a
different `signature_hash`, and therefore a unique `op_index`.

## Capability Handle Table

The host builds a `u32` handle table in `op_index` order and writes it to the
dedicated effect memory:

```
memory_effects[0..op_count] = u32 handles
```

The host then calls:

```
init_effects()
```

The module reads from `memory_effects` during `perform`. This memory is
exclusive to effect handles and must not be reused for other buffers.

## Effect Requests

Effect requests include:

- `effect_id`
- `op_id`
- `resume_kind`
- `args`
- `continuation`
- `tail_guard`
- **`handle`** (new): host capability for dispatch

Hosts should dispatch by `handle`. `effect_id` and `op_id` are retained for
diagnostics and wasm-side resume decoding.

## Host Handshake (Happy Path)

1. Instantiate WASM module.
2. Read `__voyd_effect_table`.
3. Validate table version and ABI compatibility.
4. Build a mapping from `(effect_id, op_id, signature_hash)` to host handlers.
5. Allocate handles and write a `u32` handle table by `op_index` into
   `memory_effects`.
6. Call `init_effects`.
7. Run entry point. When effects occur, dispatch by handle and resume via
   `resume_effectful`.

## Validation Rules

Hosts must fail fast on:

- Unsupported table version.
- Missing handler for any op entry used in the program.
- Signature hash mismatch between host handler and module op entry.

## Visibility Rules

- Public effects (reachable from `pkg.voyd` exports) must use explicit stable
  IDs (`@effect(id: "...")`) for release builds.
- Internal effects may use compiler-generated ids.

## Error Semantics

Failure to initialize handles or mismatch signatures must result in a hard
error. Silent fallback to name-based resolution is not allowed in release mode.
