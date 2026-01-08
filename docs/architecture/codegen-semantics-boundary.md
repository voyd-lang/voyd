# Codegen/Semantics Boundary

This document defines the stable interface between semantics and codegen in the compiler.

## Contract

Semantics produces a whole-program, codegen-oriented artifact:

- `ProgramCodegenView` (`packages/compiler/src/semantics/codegen-view/index.ts`)

Codegen consumes this view as its only source of program-wide semantic meaning.

## What Semantics Guarantees

- A single program-wide `TypeArena` shared across all modules in the compilation unit.
- A program-wide `EffectInterner` (canonical effect rows) used by typing and codegen.
- Deterministic, stable iteration order for codegen-relevant indexes (modules, impl sets, instance sets).
- Codegen-facing indexes for:
  - type descriptors/layout information
  - nominal ownership/instances
  - trait dispatch inputs (impl sets and method mappings)
  - call-site lowering info (targets, type arguments, instance keys, trait-dispatch flags)
  - primitive type ids used by lowering

## What Codegen May Assume

- `TypeId` and `EffectRowId` are globally meaningful within a compilation unit.
- Nominal identity is represented canonically via `SymbolRef` (`{ moduleId, symbol }`).
- Call-site resolution has already happened; codegen does not re-run overload/trait resolution.

## What Codegen Must Not Do

- Import or read typing internals (`TypingResult`, `TypeTable`, `FunctionStore`, `ObjectStore`, `TraitStore`, etc).
- Use binding/import metadata to resolve semantic identity (other than WASM import wiring).
- Walk typing stores to reconstruct layouts, ancestry, or dispatch tables.

## Allowed Dependencies (Codegen)

- IDs and stable cross-layer types: `TypeId`, `EffectRowId`, `SymbolRef`
- Program interface: `ProgramCodegenView`
- `TypeArena` APIs provided through `ProgramCodegenView.arena`

