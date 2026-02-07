# Variance-Aware Nominal Compatibility

Status: Proposed  
Owner: Compiler Architecture Working Group  
Scope: `packages/compiler/src/semantics/typing/*`, `packages/compiler/src/codegen/types.ts`, `packages/compiler/src/semantics/codegen-view/*`, `packages/reference/types/*`

## Goal

Make nominal generic compatibility sound by honoring per-parameter variance (co/contra/invariant) in both typing and RTT ancestry/matching.

## Problem

Today all nominal type arguments are treated as *covariant* during compatibility checks. This is fine while the language only models covariance, but it becomes unsound as soon as we allow:

- **Invariant parameters** (e.g., mutable fields), or
- **Contravariant parameters** (e.g., function inputs).

The compiler currently has no way to express or enforce these distinctions, and RTT ancestry (`addCompatibleSuperInstantiations`) uses the same covariant assumption. If variance is introduced later without updating these paths, the runtime type checks will accept invalid values.

## Non-goals

- Inferring variance automatically in this proposal.
- Changing structural typing rules.
- Rewriting type alias recursion rules.

## Proposal

### 1) Add variance annotations to nominal type parameters

Introduce explicit variance markers on object/trait type parameters:

```voyd
obj Producer<out T> { value: T }
obj Consumer<in T> { consume: fn(T) -> void }
obj Cell<T> { mut value: T } // invariant by default
```

Suggested syntax options (pick one):

- `out T` / `in T` (Rust/C# style), or
- `+T` / `-T` (short form), with no marker = invariant.

Default should be **invariant** to keep the system sound when the author does not annotate.

### 2) Preserve variance metadata in templates

Store variance per type param on object/trait templates and thread it through:

- Typing context (object/trait template registries)
- Codegen view (`buildProgramCodegenView`)

### 3) Variance-aware nominal compatibility

Update `nominalSatisfies` (and any other nominal compatibility checks) to use variance:

- **Covariant:** `actualArg` must satisfy `expectedArg`.
- **Contravariant:** `expectedArg` must satisfy `actualArg`.
- **Invariant:** both directions must satisfy (or a direct equality check if preferred).

### 4) Variance-aware RTT ancestry

Update `addCompatibleSuperInstantiations` in `packages/compiler/src/codegen/types.ts` to use the same variance rules when deciding which instantiations belong in the ancestor table. This keeps runtime match/type guards aligned with the typing rules.

### 5) Diagnostics and migration

- If variance annotations are introduced, emit a diagnostic when a nominal declaration omits annotations on any parameter (optional during a migration window).
- Provide a short migration guide and quick fixes in docs.

## Testing

Add tests that demonstrate:

- Invariant params reject substitution (`Cell<Dog>` is not `Cell<Animal>`).
- Contravariant params accept the correct direction (`Consumer<Animal>` is a `Consumer<Dog>` but not the reverse).
- Covariant params continue to behave as today.
- RTT match behavior mirrors typing for nominal generics (runtime match guards reject invalid instantiations).

## Docs updates

- **Reference:** update `packages/reference/types/objects.md` to document variance and remove the “covariance-only” gap note.
- **Proposal:** note in this document that the reference has been updated after implementation.

## Open Questions

- Do we support variance annotations for type aliases and traits as well as objects?
- Should invariance be the default from day one, or do we need a staged rollout?
- Do we want variance inference as a follow-up (e.g., mark params as invariant when used in mutable positions)?
