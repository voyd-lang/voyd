# Host Boundary DTO Compatibility

Status: Active
Owner: Compiler + Stdlib
Scope: every automatic Wasm/host boundary

## Purpose

Define the DTO contract shared by exports, effects, callbacks, external package
calls, and lowered runtime values.

## Payload Contract

Every closed DTO-eligible type has one compiler-derived `AutoDtoPlan`. The plan
owns field names and order, optionality, primitive widths, bytes, variants,
recursive references, validation, and its canonical schema fingerprint.

Ordinary structural objects, arrays, unions, primitives, and `Bytes` are
eligible when every reachable value is eligible. Functions, effects, borrowed
references, mutable identity-bearing state, and host resources are rejected
with a diagnostic at the boundary that requires a DTO.

An exceptional nominal type may implement `CustomDto<T, Representation>`.
`Representation` must itself be DTO-eligible and is shared by every format and
host route. There are no format-specific serializers.

## Transport contract

One build-selected host transport carries ABI-v2 frames for every automatic
route. Each typed position includes the fingerprint from its DTO plan. The
module metadata records `hostAbi`, `dtoSchemaAbi`, and the exact transport ID
and version. Host initialization fails before user code runs when the matching
adapter is unavailable.

The transport is an outer framing protocol. Application JSON and MessagePack
remain explicit structured-format APIs and never select the host transport.

## Naming Rule

Effect ops and top-level wrapper functions may share the same name. Binder and
value resolution treat these as distinct call paths:

- `Effect::op(...)` resolves to the effect operation.
- `op(...)` resolves to the wrapper function in value position.

No wrapper renaming/module-split workaround is required.

The complete design and migration requirements are specified in
[`docs/proposals/encoding-and-vx-dto.md`](../proposals/encoding-and-vx-dto.md).
