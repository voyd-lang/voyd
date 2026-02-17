# Compiler Blocker: Cross-Module Constraint Proof for `DictKey` (Resolved)

## Resolution Summary

The `TY9999` blocker on constrained `Dict<K: DictKey<K>, V>` is fixed.

`Dict<String, MsgPack>::init()` no longer fails constraint proof in downstream modules.

## Root Cause

1. Imported object processing only harvested constraint traits from object type params, not from constrained imported member signatures (for example `init` inside constrained impl blocks).
2. Constraint checks depended on local trait alias presence; cross-module cases could fail when alias mapping was absent.
3. Imported function signature translation kept dependency `typeParamMap` instead of remapped local symbols/types.

## Implemented Fix

1. `packages/compiler/src/semantics/typing/import-symbol-mapping.ts`
   - `registerImportedObjectTemplate` now also scans imported member signatures (`dependency.typing.memberMetadata` + function signatures) and collects trait constraints from those type params.
   - Collected constraint traits now trigger `registerImportedTraitDecl` + `registerImportedTraitImplTemplates`.
   - `mapDependencySymbolToLocal(... allowUnexported: true)` no longer adds unexported symbols to `importsByLocal` (prevents export-resolution crashes during import priming).
2. `packages/compiler/src/semantics/typing/type-system.ts`
   - Trait satisfaction no longer hard-fails when no local trait alias exists; it falls back to symbol-ref based trait matching.
3. `packages/compiler/src/semantics/typing/import-type-translation.ts`
   - Imported signatures now remap `typeParamMap` to local type-parameter symbols and translated type refs.
4. `packages/compiler/src/semantics/typing/expressions/call.ts`
   - Imported method signature resolution now ensures constraint-trait declarations/impl templates are registered for constrained imported signatures.

## Regression Coverage Added

1. `packages/compiler/src/semantics/__tests__/pipeline.test.ts`
   - Added cross-module constrained-object test.
   - Added transitive key-type dependency constrained-object test.
2. Added fixtures:
   - `packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_cross_module/dep.voyd`
   - `packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_cross_module/main.voyd`
   - `packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_cross_module_transitive/key_type.voyd`
   - `packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_cross_module_transitive/dep.voyd`
   - `packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_cross_module_transitive/main.voyd`

## Validation

1. `npx vitest packages/compiler/src/semantics/__tests__/pipeline.test.ts` passes.
2. `npx vitest packages/compiler/src/semantics/typing/__tests__/imports.test.ts packages/compiler/src/semantics/typing/__tests__/trait-impls.test.ts` passes.
3. `npx vitest packages/compiler/src/semantics/typing/__tests__/function-generics.test.ts packages/compiler/src/semantics/typing/__tests__/method-call-resolution.test.ts` passes.
4. `npm run typecheck --workspace @voyd/compiler` passes.
5. `npm run test --workspace @voyd/std` no longer fails with `TY9999`; it now fails later on an unrelated codegen blocker:
   - `CG0001: codegen missing binding for symbol less`
   - tracked in `compiler_blocker_codegen_less_binding.md`.

## Last Verified

1. Date: `2026-02-17`
2. Dict constraint status: resolved.
3. Current top blocker for full std gate: `CG0001` (codegen).
