# Program-Wide Symbol Arena (Whole-Program Symbol Identity)

Status: Implemented
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
  - `idOf(ref: SymbolRef): ProgramSymbolId`
  - `tryIdOf(ref: SymbolRef): ProgramSymbolId | undefined`
  - `refOf(id: ProgramSymbolId): SymbolRef`
  - `getName(id: ProgramSymbolId): string` (or `string | undefined`)
  - `getPackageId(id: ProgramSymbolId): string`
  - `getIntrinsicFlags(id: ProgramSymbolId)` / `getIntrinsicName(id: ProgramSymbolId)` / etc.

### Identity Contract

This proposal defines a strict identity hierarchy:

- `SymbolId`: module-local identity. It must never be used as a whole-program map key.
- `SymbolRef`: stable serialization/debug identity (`{ moduleId, symbol }`), and an external boundary identifier for diagnostics and debugging.
- `ProgramSymbolId`: canonical whole-program indexing identity, used for all codegen-relevant whole-program maps and stable artifacts.

**Rule of thumb:** use `ProgramSymbolId` for *indexing*; use `SymbolRef` only for *printing/debugging/serialization* via `ProgramSymbolArena.refOf`.

### Population Set

The arena assigns ids for **all declared symbols** in the compilation unit, not just “symbols discovered by a pass”.

This avoids “intern as discovered” bugs and makes determinism testable: any two compilations of the same module set produce the same id assignment, independent of pipeline traversal order.

### New Rule

All **whole-program** semantic artifacts and indexes must use `ProgramSymbolId` as their key/value identity:

- monomorphized instances
- any cross-module call target identity / call lowering info
- trait impl sets and method maps
- export tables used for codegen
- wasm import/export wiring where a symbol identity is required

`SymbolId` remains strictly module-local and must not escape module semantics.

`SymbolRef` remains a serialization/debug identity, but is not used for indexing once interned.

## ProgramCodegenView Changes

`ProgramCodegenView` becomes the single, stable boundary and exposes `ProgramSymbolArena`:

- `program.symbols` is keyed by `ProgramSymbolId` (and provides `refOf` for debug output)
- codegen no longer needs `moduleId` + `SymbolId` pairs for semantic identity; it uses `ProgramSymbolId` everywhere a symbol identity is required

### TypeArena Integration (Long-Term, Preferred)

To fully eliminate `SymbolRef` usage as an indexing identity at the boundary, `TypeArena` should not embed `SymbolRef` as “nominal owner” in type descriptors.

Preferred long-term shape:

- Type descriptors that currently store `owner: SymbolRef` (e.g. nominal objects / traits) should instead store `owner: ProgramSymbolId`.
- Any operation that needs module-local or debug identity uses `ProgramSymbolArena.refOf(ownerId)` (or `getName(ownerId)`, etc).

This makes “codegen consumes `ProgramCodegenView` only” mechanically enforceable: codegen never needs to pull in `SymbolRef` for identity, and the only sanctioned way to obtain debug-friendly identity is through the arena.

Any codegen-side maps keyed by symbols should use `ProgramSymbolId` directly (no string key composition).

## Determinism Requirements

The arena must be deterministic:

- stable module iteration order
- stable symbol iteration order per module (by `SymbolId`)
- stable interning order derived from the above (do not depend on JS `Map` insertion order from upstream passes)

Two identical compilations must assign the same `ProgramSymbolId` mapping.

### Deterministic Assignment Algorithm

To remove ambiguity, the assignment algorithm is part of the contract:

1. Collect all modules included in the compilation unit into `stableModules`, sorted by `moduleId` ascending using `localeCompare(..., { numeric: true })`.
2. For each module in `stableModules`, snapshot the module’s symbol table.
3. Iterate symbols in that snapshot in ascending `SymbolId` order (numeric order), skipping empty slots.
4. For each symbol, compute its `SymbolRef = { moduleId, symbol }` and assign the next contiguous `ProgramSymbolId` (starting from 0) if not already assigned.

After this build step, the arena is immutable; `idOf(ref)` is a lookup (and should throw if asked for a ref not present in the compilation unit).

## Migration Plan (Single Step)

This proposal is not implemented incrementally. The implementation must:

1. Add `ProgramSymbolId` + `ProgramSymbolArena`.
2. Update `monomorphizeProgram` output to use `ProgramSymbolId`.
3. Update `ProgramCodegenView` to use `ProgramSymbolId` everywhere symbols appear.
4. Update `TypeArena` nominal ownership to use `ProgramSymbolId` (remove `SymbolRef` owner fields from type descriptors at the boundary).
5. Update codegen to consume the new symbol ids (remove `SymbolRef`/`SymbolId` semantic identity usage).
6. Update tests to assert via `ProgramSymbolId`-based indexes.
7. Delete dead adapters and old symbol identity helpers.

## Success Criteria

- `npm test` passes.
- Codegen does not require `SymbolId` for semantic identity (only for module-local HIR bindings if unavoidable).
- No `moduleId::...` string keys remain for symbol identity in public-facing artifacts.
- Whole-program indexes are deterministic and stable.
- Add a determinism test: building a `ProgramSymbolArena` from the same module set with different module discovery/traversal orders assigns identical ids.
