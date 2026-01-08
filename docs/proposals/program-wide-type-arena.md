# Program-Wide Shared Type Arena

Status: Draft  
Owner: Compiler Architecture Working Group  
Scope: `packages/compiler/src/semantics/typing/*`, `packages/compiler/src/semantics/linking.ts`, `packages/compiler/src/pipeline.ts`

## Overview

Today, each module gets its own `TypeArena` (and `EffectTable`). That makes `TypeId`
and `EffectRowId` *module-local*, which forces the compiler to:

- Translate types across arenas during imports (`createTypeTranslation`).
- Link imported generic instantiations as a whole-program pass (`linkProgramSemantics`).
- Avoid using `TypeId` as a runtime identity (because the same conceptual type has different `TypeId`s in different modules).

This proposal moves to a program-wide shared arena so that all modules in a
single compilation share a single `TypeArena` (and, optionally, a single
`EffectTable`). This yields global `TypeId`s within that compilation unit and
eliminates most cross-module translation.

## Goals

1. Make `TypeId` and `EffectRowId` globally meaningful within a single compilation.
2. Eliminate (or drastically reduce) cross-module type translation for imports.
3. Simplify whole-program features (generic monomorphization, RTT/shape identity).
4. Reduce the number of “semantics mutation” passes that run after module typing.

## Non-Goals

- Stable type ids across different compiler runs (build-to-build determinism).
- Incremental compilation or caching across runs (can be layered later).
- Changing surface language semantics.

## Problem Statement

The per-module arena model bakes “module-local identity” into `TypeId`. That’s
fine internally for a module, but it becomes a liability at boundaries:

- Two modules can compute structurally identical types that do not compare equal
  because they live in different arenas.
- Imported nominal types must be re-interned in the importing module’s arena,
  creating duplicate identities.
- Runtime systems (match/type tests, dynamic field/method lookup) cannot safely
  use `TypeId` as an identity without additional “canonicalization” logic.

The workarounds (translation, post-pass instantiation materialization, hashed
runtime ids) are correct but accumulate complexity and create new failure modes
(e.g. hash collisions).

## Proposed Design

### 1) ProgramTypingState

Introduce a program-level container that owns all shared, interned state:

- `TypeArena` (required)
- `EffectTable` (strongly recommended)
- Any program-wide registries (intrinsic type ids, well-known primitives, etc.)

Every module’s typing context references the same program-owned arena(s).

### 2) Canonical Symbol Identity in Type Descriptors

A shared arena only helps if the “owner identity” used inside type descriptors
is also stable across modules.

Currently, `TypeArena` stores `owner: SymbolId` for nominal objects and traits.
But `SymbolId` is per-module (each module builds its own `SymbolTable`), so the
same declared nominal type has different owner ids across importing modules.

To fix this, update type descriptors to reference a canonical symbol identity:

```ts
type SymbolRef = { moduleId: string; symbol: number };
```

Then update the arena descriptors:

- `TraitType.owner: SymbolRef`
- `NominalObjectType.owner: SymbolRef`

With this representation, `Some<T>` imported into a module still interns to the
same type as the defining module, because the owner ref matches.

Implementation note: for local declarations, `SymbolRef` is trivially
`{ moduleId: currentModuleId, symbol: localSymbolId }`. For imports, the binder
already records `metadata.import = { moduleId, symbol }` on the local alias;
use that as the canonical ref.

### 3) Imports Become “SymbolRef Wiring”, Not “Type Translation”

With a shared arena and canonical owner identity:

- Translating `TypeId`s between arenas is unnecessary (they already live in the
  same arena).
- Import resolution still needs to map *symbols* (local alias to imported target),
  but type identity is preserved automatically.

Existing utilities such as `createTypeTranslation` can either be deleted or
reduced to:

- Effect-row translation (if effect tables are *not* shared).
- Symbol metadata propagation (member metadata, intrinsic flags, etc.).

### 4) Generic Monomorphization as a First-Class Whole-Program Pass

`linkProgramSemantics` exists because the caller can
discover instantiations that require typing work in the callee module.

With a shared arena, we still need whole-program monomorphization, but it
should become an explicit pass with clear inputs/outputs rather than mutating
per-module semantics objects.

Suggested shape:

- Record instantiation requests during typing (caller module).
- After all modules are typed, perform a monomorphization pass that:
  - Ensures all requested instantiations are typed
  - Is idempotent and produces a deterministic instantiation set

### 5) Runtime Type Identity Simplification

Once `TypeId` is program-wide (and nominal owners are canonical), the runtime
can use `TypeId` directly for:

- `match` type tests
- Ancestor tables

This can replace hashed runtime type ids entirely (and remove collision risks),
or keep hashing only if there’s a specific backend constraint requiring it.

## Migration / Implementation Guidance

### Phase 0: Prep (No Behavior Change)

1. Add `SymbolRef` type (moduleId + symbol) in semantics.
2. Add a helper `canonicalSymbolRef(symbolId, symbolTable, moduleId)`:
   - If `symbolId` is an imported alias, return its `metadata.import` target.
   - Otherwise return `{ moduleId, symbol: symbolId }`.

### Phase 1: Shared Interners

1. Thread a program-owned `TypeArena` through `runTypingPipeline` / `createTypingContext`.
2. (Recommended) Thread a program-owned `EffectTable` similarly to avoid effect-row translation.
3. Ensure all modules in `analyzeModules` share these instances.

### Phase 2: Canonical Owners in the Arena

1. Update `TypeArena` descriptor shapes (`trait`, `nominal-object`) to store `SymbolRef`.
2. Update all typing/codegen sites that construct or inspect these descriptors.
3. Ensure interning keys remain deterministic with `SymbolRef` included.

### Phase 3: Cleanups and Simplification

1. Remove or significantly reduce `createTypeTranslation` for imports.
2. Replace `linkProgramSemantics` with an explicit, tested whole-program monomorphization pass.
3. Switch runtime type identity to use program-wide `TypeId` (or keep hashing with collision checks as a transitional measure).

## Risks and Tradeoffs

- **Concurrency**: a shared arena introduces shared mutable state. If the typing
  pipeline becomes parallel, arena operations must be synchronized or confined.
- **Memory growth**: global interning can retain more types; mitigation includes
  phase-scoped arenas or careful canonicalization (already present for unions/structural fields).
- **API churn**: many call sites assume `owner: SymbolId`; migrating to `SymbolRef`
  will touch a wide surface area.

## Success Criteria

- Cross-module RTT/type tests can use `TypeId` directly without hashing.
- Import-heavy code eliminates most type translation work.
- `linkProgramSemantics` is removed or replaced by a
  deterministic whole-program monomorphization pass.
