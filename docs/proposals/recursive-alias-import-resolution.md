# Recursive Alias Import Resolution

Status: Draft  
Owner: Compiler / Typing  
Scope: `packages/compiler/src/semantics/typing/*`, `packages/compiler/src/semantics/codegen-view/*`

## Goal

Ensure imported recursive type aliases resolve to their recursive wrapper type
(`recursive` descriptor) rather than the unfolded body, so binder references never
escape into codegen as unresolved `type-param-ref` values.

## Problem

In some import paths, recursive aliases can be resolved to the *unfolded body*
(e.g. a union or nominal) instead of the recursive wrapper. When that body
contains the alias binder, the binder can appear as a bare `type-param-ref`
outside the recursive context. This leaks an unbound type parameter into
codegen and forces downstream fallbacks (e.g. widening to `baseType`).

This is not a heap-type emission issue; it’s a typing/import-resolution issue.

## Non-goals

- Changing type alias contractiveness rules.
- Rewriting codegen RTT or recursive heap type lowering (see
  `docs/proposals/recursive-heap-types.md`).

## Proposal

### 1) Preserve recursive wrapper identity at alias resolution boundaries

When resolving a recursive alias (local or imported), prefer returning the
recursive wrapper `TypeId` (the `recursive` descriptor) rather than the
unfolded body. This should be true for:

- Type alias resolution in `resolveTypeAlias`.
- Imported alias resolution in `resolveImportedAlias` / `resolveImportedTypeExpr`.

The unfolded form is still needed for contractiveness checks, but should not be
the *returned* `TypeId` used by signatures or caches.

### 2) Cache the wrapper, not the unfolded body

The type alias cache should store the wrapper `TypeId`. If contractiveness
requires inspecting the body, use the arena’s recursive unfold cache or explicit
substitution for validation only.

### 3) Codegen-view should only see wrapper ids

`buildProgramCodegenView` should only observe recursive aliases via the wrapper
id. This guarantees:

- `getTypeDesc` for a recursive alias yields `{ kind: "recursive", binder, body }`,
  never a body containing an unbound binder.
- `type-param-ref` with a recursive binder only appears under an active
  `recursive` context.

## Implementation Sketch

1) In `resolveTypeAlias`, keep the recursive wrapper id (`self`) as the final
   resolved type for caching and return value.
2) Ensure `resolveImportedAlias` returns the wrapper id from the dependency
   arena, and translation preserves it (i.e. do not translate it to the body).
3) Use the existing contractiveness checks on the unfolded body, but do not
   expose it as the alias’s public `TypeId`.

## Testing

Add tests that:

- Import a recursive alias through a wrapper module and ensure function
  signatures contain a `recursive` type id (not the unfolded body).
- Confirm that codegen lowering never sees a top-level `type-param-ref` without
  a recursive binder when targeting the alias return type.

## Success Criteria

- No unresolved recursive binders reach codegen for imported alias returns.
- The same alias resolves to the same wrapper id across direct and imported
  resolution paths.

