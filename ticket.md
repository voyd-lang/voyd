# Ticket: Centralize “Shared Interner” Detection for Import Typing

## Background
`resolveImportedValue` in `packages/compiler/src/semantics/typing/imports.ts` has a fast-path that reuses a dependency’s already-typed schemes/signatures when the importing module can safely share the dependency’s type IDs.

Historically this was gated by object identity checks:
- `dependency.typing.arena === ctx.arena`
- `dependency.typing.effects === ctx.effects`

In practice, multiple `EffectTable` instances can be “logically shared” (i.e. compatible) when they share the same effect-row interner (`internRow`). Treating them as non-shared forces translation, which can break identity-sensitive constructs like recursive type aliases (e.g. `MsgPack`), and cascades into downstream codegen decisions (e.g. export ABI inferred as `direct` instead of `serialized`).

## Problem
“Shared-ness” is currently determined ad-hoc and too strictly in at least one place (import typing). As more compiler phases depend on stable identity for nominal/alias types and effect rows, relying on object identity comparisons is fragile and easy to repeat incorrectly elsewhere.

## Proposal
Introduce a single, explicit concept of “shared interners” (or “shared typing context”) and use it everywhere import translation decisions are made.

Options (pick one):
1. **Helper function**: `typingContextsShareInterners(a, b)` or `effectsShareInterner(aEffects, bEffects)` and use it in:
   - `resolveImportedValue`
   - `resolveImportedTypeExpr`
   - any other translation/fast-path logic in `packages/compiler/src/semantics/typing/*`
2. **Stable interner identity**: add an explicit `internerId` to the effect interner/table and (optionally) arena, so the check is:
   - `arena.internerId === arena.internerId && effects.internerId === effects.internerId`
3. **Unify effect interner creation**: ensure all modules that should share interners literally share the same `EffectTable` instance (harder if per-module state is embedded).

## Acceptance Criteria
- Compiler has a single, documented way to decide whether two typing contexts can reuse type/effect identities without translation.
- Import typing fast-path never breaks recursive alias identity (`MsgPack` or future recursive aliases).
- Add a focused regression test that:
  - imports a recursive alias across modules
  - asserts the imported function’s return type preserves alias symbols/serializer metadata (or asserts export ABI is `serialized` when appropriate).

## Notes / Risks
- Comparing `internRow` function identity is a pragmatic proxy today, but it’s an implementation detail; a dedicated `internerId` would make this intent explicit and future-proof.
- Be careful to distinguish “shared interner” from “shared table/state”. Sharing interners should only imply IDs are interchangeable, not that per-module effect assignments are shared.
