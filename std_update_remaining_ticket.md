# Remaining Work To Complete `std_update_spec.md`

## Status

Closed for this migration pass.

All previously tracked blockers in this ticket are resolved, and the validation matrix is green.

## What Was Completed

1. Compiler blockers in the prior chain were resolved:
   - `compiler_blocker_dict_constraints.md`
   - `compiler_blocker_codegen_less_binding.md`
   - `compiler_blocker_codegen_call_arg_mismatch_string_value.md`
2. String type-shape migration was completed:
   - `StringSlice` is now a concrete view object.
   - `StringIndex` is now a concrete index object.
   - Rune/grapheme stepping/search APIs use the new index/view model.
3. Dict migration is complete with key constraints:
   - `Dict<K, V>` and `DictKey<K>` are enforced in std surfaces.
4. Required std tests are in dedicated `*.test.voyd` files for core modules and traits.
5. Coverage was extended for renamed APIs and new string/dict surfaces.

## Validation (Last Verified `2026-02-17`)

1. `npm run test --workspace @voyd/std` passed (75/75).
2. `npm run test --workspace @voyd/compiler` passed.
3. `npm run typecheck --workspace @voyd/compiler` passed.
4. `npm run test --workspace @voyd/cli` passed.
5. `npm run typecheck --workspace @voyd/cli` passed.
6. `npm test` passed.
7. `npm run typecheck` passed.

## Intentional Divergence Tracked

1. `Copy` remains method-based (`copy(self) -> T`) instead of marker-style.
2. Reason: current language/parser model requires trait members.
3. This is documented divergence, not a release blocker for `std_update_spec.md`.
