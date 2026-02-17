# Remaining Work To Complete `std_update_spec.md`

## Current State

1. `Dict<K, V>` + `DictKey` exist and most API surface from `std_update_spec.md` is implemented for `String`, `Array`, and `Dict`.
2. Dedicated test files now exist for:
   - `packages/std/src/string/type.test.voyd`
   - `packages/std/src/array.test.voyd`
   - `packages/std/src/dict.test.voyd`
   - `packages/std/src/traits/contracts.test.voyd`
3. `@voyd/std` still does not pass, but the previous `DictKey` constraint blocker is resolved.
4. Current top blocker is now codegen:
   - `CG0001: call argument count mismatch for value (call 5905 in std::string::type): argument/parameter mismatch`
   - tracked in `compiler_blocker_codegen_call_arg_mismatch_string_value.md`.

Last verified on `2026-02-17` via:
- `npm run test --workspace @voyd/std`

## Remaining Work

## 1. Compiler Blocker (Hard)

1. Resolve the new codegen blocker:
   - `compiler_blocker_codegen_call_arg_mismatch_string_value.md`
2. Re-run and pass the full validation matrix after codegen fix.

## 2. String Type-Shape Gap

1. `StringSlice` is still an alias (`pub type StringSlice = String`), not an explicit zero-copy slice view type.
2. `StringIndex` is still a raw alias (`pub type StringIndex = i32`), not an opaque index type.
3. Implement the concrete type-shape migration while preserving current rune/grapheme boundary guarantees.

## 3. Trait Alignment Gap

1. `Copy` remains method-based because current parser requires trait bodies with members.
2. Decide final direction:
   - add marker-trait support in language/compiler, then switch `Copy` to marker, or
   - formally document intentional divergence from spec.

## 4. Coverage Closure

1. Complete a method-by-method coverage audit against `std_update_spec.md`.
2. Add missing edge/failure-path tests where any API method is not directly covered yet.
3. Keep tests only in `*.test.voyd` files.

## 5. Validation Gates (Must Pass)

1. `npm run test --workspace @voyd/std`
2. `npm run test --workspace @voyd/compiler`
3. `npm run typecheck --workspace @voyd/compiler`
4. `npm run test --workspace @voyd/cli`
5. `npm run typecheck --workspace @voyd/cli`
