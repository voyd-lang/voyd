# Program-Wide Function Instance IDs (Eliminate String Instance Keys at the Boundary)

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/semantics/*`, `packages/compiler/src/codegen/*`, pipeline and tests

## Goal (Non-Incremental)

Remove stringly-typed instance identity (`"symbol<...>"`, `"moduleId::..."`) from whole-program lowering artifacts and from the codegen boundary.

This proposal is intended to be implemented in the same change set as `docs/proposals/program-symbol-arena.md`.

## Problem

The current pipeline uses string keys for function instances and call target maps:

- function instance identity is represented as a string (e.g. `"12<3,4>"`)
- cross-module instance identity becomes a composed string (e.g. `"std::util::12<...>"`)
- call target maps are keyed by those strings (per-caller-instance specialization)

This creates correctness risks (key mismatches, double-scoping bugs) and makes it harder to enforce determinism and boundary hygiene.

## Proposal

### New IDs

Introduce two program-wide ids:

```ts
type ProgramFunctionId = number & { readonly __brand: "ProgramFunctionId" };
type ProgramFunctionInstanceId = number & { readonly __brand: "ProgramFunctionInstanceId" };
```

Definitions:

- `ProgramFunctionId` identifies a function symbol in the program. It should be equivalent to `ProgramSymbolId` for “function symbols” (i.e. reuse `ProgramSymbolId` rather than inventing a second id unless there is a strong reason).
- `ProgramFunctionInstanceId` identifies a particular instantiation of a generic (or the monomorphic base instance).

### Deterministic Assignment

Assignment is part of the contract:

1. Iterate `ProgramFunctionId`s in ascending numeric order.
2. For each function, iterate its known instantiations in a deterministic order:
   - sort by the canonicalized `typeArgs` vector (numeric `TypeId` comparison, lexicographic)
3. Assign contiguous `ProgramFunctionInstanceId`s.

### Boundary Shape Changes

Replace the following boundary surfaces:

- `CallLoweringInfo.targets?: ReadonlyMap<string, SymbolId>`
  - becomes `targets?: ReadonlyMap<ProgramFunctionInstanceId, ProgramFunctionId>`
- `CallLoweringInfo.instanceKey?: string`
  - becomes `callerInstance?: ProgramFunctionInstanceId` (or remove if implicit)
- `MonomorphizedInstanceInfo.instanceKey: string`
  - becomes `instanceId: ProgramFunctionInstanceId`

Codegen’s `FunctionContext.instanceKey` / `typeInstanceKey` should become `ProgramFunctionInstanceId` (plus an optional debug string for error messages).

### Debuggability

Provide debug helpers on `ProgramCodegenView`:

- `functions.formatInstance(instanceId): string`
- `functions.getInstance(instanceId): { functionId, typeArgs, symbolRef, ... }`

These are used for diagnostics and logs only; identity in codegen remains numeric.

## Migration Plan (Single PR)

1. Land `ProgramSymbolArena` and `ProgramSymbolId` (see `program-symbol-arena.md`).
2. Add `ProgramFunctionInstanceId` assignment in the semantics linking/monomorphization stage (or in the `ProgramCodegenView` build step, as long as it is deterministic and complete).
3. Update call lowering structures to use `ProgramFunctionInstanceId`.
4. Update codegen to use numeric ids throughout call dispatch and function instance metadata.
5. Delete string key helpers (`makeInstanceKey`, `symbolRefKey`, and any `moduleId::...` key composition used for identity).

## Success Criteria

- No string-key maps remain for function instance identity at the codegen boundary.
- Whole-program instance identity is deterministic and stable.
- All tests pass.
