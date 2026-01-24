# Recursive Heap Types in Codegen

Status: Proposed  
Owner: Compiler Architecture Working Group  
Scope: `packages/compiler/src/codegen/*`, `packages/lib/src/lib/binaryen-gc/type-builder.ts`, `docs/proposals/compiler-type-lowering-phases-and-recursive-types.md`

## Goal

Emit real recursive wasm GC heap types for recursive structural/nominal types so that
field types remain precise (instead of widening recursive references to the base RTT type).

## Problem

The current codegen path widens recursive cycles to `ctx.rtt.baseType` when recursion
is detected during `wasmTypeFor`. This prevents infinite recursion, but loses precision
for recursive fields and prevents the runtime RTT from reflecting true heap shape.

This is acceptable as a temporary fallback, but it blocks correctness checks that rely
on exact heap types and makes recursive data structures overly permissive in wasm GC.

## Non-goals

- Changing the typing rules for recursive aliases.
- Encoding recursion for non-reference primitives.
- Rewriting the signature-lowering path (that should remain conservative).

## Proposal

### 1) Build recursive groups with SCCs

Collect a dependency graph over *structural type ids*:

- A node is a structural type id.
- There is an edge from `A` to `B` if any field of `A` contains `B` (directly or via
  nominal wrapper).

Compute strongly connected components (SCCs). Each SCC becomes one recursive wasm
type group to be emitted together.

### 2) Use Binaryen’s TypeBuilder for recursive structs

For each SCC:

1. Allocate a `TypeBuilder` sized to the number of types in the SCC.
2. Assign each structural type id a stable index within the builder.
3. For each structural type, compute its wasm field types:
   - If the field type points to a structural type **in the same SCC**, use
     `builder.getTempRefType(index, /*nullable*/ true)` as the field type.
   - Otherwise, lower the field type via the existing `wasmRuntimeTypeFor` path.
4. Call `builder.setStructType(index, fields, supertype)` for each node.
5. Build the recursive group via `builder.buildAndDispose`.

This yields concrete heap types with correct recursive references.

### 3) Integrate with `getStructuralTypeInfo`

Introduce a new helper (e.g. `ensureStructuralRuntimeTypes`) that:

- Checks the structural cache.
- If the type is part of an SCC group not yet built, builds the entire group via
  the TypeBuilder logic above.
- Returns the precise runtime heap type for each structural object.

`getStructuralTypeInfo` can then use that runtime heap type for field typing, while
keeping `interfaceType` as `ctx.rtt.baseType` for ABI compatibility.

### 4) Keep signature lowering conservative

Signature lowering should remain conservative and *not* trigger recursive heap
type emission. The recursive group builder should only run during the runtime RTT
construction phase.

### 5) Diagnostics and failure mode

If `TypeBuilder` fails (`_TypeBuilderBuildAndDispose` reports an error), surface a
codegen diagnostic that includes:

- module id
- structural type id
- error index/reason from Binaryen

## Testing

Add tests that verify:

- Recursive alias fields retain concrete heap types (not base RTT type).
- Mutually recursive objects across modules produce deterministic recursive groups.
- Existing RTT key canonicalization still yields stable runtime ids.

## Open Questions

- Should recursive fixed-array types be supported, and if so, should they also use
  a TypeBuilder group?
- Should `interfaceType` remain `ctx.rtt.baseType`, or should we expose a distinct
  “precise ref” type for internal field typing?
- What is the best place to store SCC metadata so that it is available to both
  RTT building and codegen passes without re-traversal?

