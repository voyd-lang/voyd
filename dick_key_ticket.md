# Ticket: Complete `DictKey` Constraint Enforcement Across Modules

## Status

Resolved and verified end-to-end.

`DictKey` cross-module constraint enforcement works with merged generic constraints, and valid `Dict<String, ...>` usage no longer triggers `TY9999`.

## What Was Fixed

1. Imported constraint traits are discovered from constrained member signatures, not only object type parameters.
2. Trait-satisfaction logic supports symbol-ref matching when local trait alias mapping is unavailable.
3. Imported function signature `typeParamMap` is remapped to local symbols/types.
4. Unexported symbol aliasing no longer pollutes import-value priming.
5. Regression tests cover:
   - constrained object methods across modules,
   - transitive key-type dependency constraints.

Detailed implementation notes remain in:
- `compiler_blocker_dict_constraints.md`

## DictKey Implementation Scope (Std)

1. `Dict` is now keyed as `Dict<K, V>` with `K: DictKey<K>`.
2. `DictKey<String>` is implemented and used by std consumers.
3. `Dict` entry/merge/map/filter surfaces compile under constraint enforcement.

## Verification

Last verified on `2026-02-17`:

1. `npm run test --workspace @voyd/std`
2. `npm run test --workspace @voyd/compiler`
3. `npm run typecheck --workspace @voyd/compiler`
4. `npm run test --workspace @voyd/cli`
5. `npm run typecheck --workspace @voyd/cli`
6. `npm test`
7. `npm run typecheck`

All gates above are currently passing.
