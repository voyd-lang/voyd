# Program-Wide Symbol Arena (Whole-Program Symbol Identity)

Status: Proposed  
Owner: Compiler Architecture Working Group  
Scope: `packages/compiler/src/semantics/*`, `packages/compiler/src/codegen/*`, pipeline and tests

## Goal (Non-Incremental)

This proposal must be implemented **all at once** in a single change set. We are in an unreleased phase and want to avoid an extended hybrid period where some subsystems use `SymbolRef`/`SymbolId` while others use a new identity type.

## Problem

The compiler currently has multiple symbol identity representations:

- `SymbolId`: per-module identity (owned by each module’s binder symbol table).
- `SymbolRef`: cross-module identity (`{ moduleId, symbol }`).

Even after introducing `ProgramCodegenView`, we still end up with:

- ad-hoc key formats (e.g. `moduleId::...`) for cross-module maps,
- repeated conversions between per-module and cross-module ids,
- difficulty enforcing “codegen does not depend on semantics internals” because some code still wants symbol metadata (intrinsics, names, scope kind) at the boundary.

Types already have a program-wide identity via a shared `TypeArena`. Symbols do not.

## Proposal

Introduce a program-wide symbol arena that assigns a stable id for every `SymbolRef` in a compilation unit:

```ts
type ProgramSymbolId = number & { readonly __brand: "ProgramSymbolId" };
```

And a semantics-owned interner:

- `ProgramSymbolArena`
  - `intern(ref: SymbolRef): ProgramSymbolId`
  - `refOf(id: ProgramSymbolId): SymbolRef`
  - `getName(id: ProgramSymbolId): string` (or `string | undefined`)
  - `getPackageId(id: ProgramSymbolId): string`
  - `getIntrinsicFlags(id: ProgramSymbolId)` / `getIntrinsicName(id: ProgramSymbolId)` / etc.

### New Rule

All **whole-program** semantic artifacts and indexes must use `ProgramSymbolId` as their key/value identity:

- monomorphized instances
- call target maps / call lowering info
- trait impl sets and method maps
- export tables used for codegen
- wasm import/export wiring where a symbol identity is required

`SymbolId` remains strictly module-local and must not escape module semantics.

`SymbolRef` remains a serialization/debug identity, but is not used for indexing once interned.

## ProgramCodegenView Changes

`ProgramCodegenView` becomes the single, stable boundary and exposes `ProgramSymbolArena`:

- `program.symbols` is keyed by `ProgramSymbolId`
- codegen no longer needs `moduleId` + `SymbolId` pairs for semantic identity; it uses `ProgramSymbolId`

Any codegen-side maps keyed by symbols should use `ProgramSymbolId` directly (no string key composition).

## Determinism Requirements

The arena must be deterministic:

- stable module iteration order
- stable symbol iteration order per module (by `SymbolId`)
- stable interning order derived from the above (do not depend on JS `Map` insertion order from upstream passes)

Two identical compilations must assign the same `ProgramSymbolId` mapping.

## Migration Plan (Single Step)

This proposal is not implemented incrementally. The implementation must:

1. Add `ProgramSymbolId` + `ProgramSymbolArena`.
2. Update `monomorphizeProgram` output to use `ProgramSymbolId`.
3. Update `ProgramCodegenView` to use `ProgramSymbolId` everywhere symbols appear.
4. Update codegen to consume the new symbol ids (remove `SymbolRef`/`SymbolId` semantic identity usage).
5. Update tests to assert via `ProgramSymbolId`-based indexes.
6. Delete dead adapters and old symbol identity helpers.

## Success Criteria

- `npm test` passes.
- Codegen does not require `SymbolId` for semantic identity (only for module-local HIR bindings if unavoidable).
- No `moduleId::...` string keys remain for symbol identity in public-facing artifacts.
- Whole-program indexes are deterministic and stable.

