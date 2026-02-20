# Host Boundary DTO Compatibility

Status: Active
Owner: Compiler + Stdlib
Scope: effect host boundary payloads (`main_effectful` / `resume_effectful`)

## Purpose

Define the payload contract used by the host boundary and the required stdlib
shim pattern so public APIs can stay ergonomic while host payloads stay stable.

## Payload Contract

Effect operation arguments and resume values that cross the host boundary must be
one of:

- `bool`
- `i32`
- `i64`
- `f32`
- `f64`
- `void`
- Any type annotated with `@serializer("msgpack", ...)`

Anything else is rejected at compile time with `CG0001` and an explicit message
that points at the specific op payload (`argN` or return value).

## Shim Pattern (Required)

When a public std API uses richer types (for example `Option`, unions, objects,
or collections), keep that API shape and convert at the effect boundary:

1. Public wrapper API uses ergonomic types.
2. Internal effect op signature uses a host DTO-compatible type from this contract.
3. Conversion helpers map `API shape -> host DTO` before `Effect::op(...)`.
4. Conversion helpers map `host DTO -> API shape` for resumed values.

This keeps host protocol compatibility isolated to a narrow boundary.

## Naming Rule

Effect ops and top-level wrapper functions may share the same name. Binder and
value resolution treat these as distinct call paths:

- `Effect::op(...)` resolves to the effect operation.
- `op(...)` resolves to the wrapper function in value position.

No wrapper renaming/module-split workaround is required.
