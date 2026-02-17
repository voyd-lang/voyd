# Compiler Blocker: `CG0001` Missing Binding for `less` (Resolved)

## Summary

After fixing the `DictKey` cross-module constraint bug, std failed in codegen with:

- `CG0001: codegen missing binding for symbol less`

This blocker is now resolved.

## Current Symptoms

1. `npm run test --workspace @voyd/std` previously failed during codegen.
2. First hard error was:
   - `packages/std/std::__voyd_test_entry__:0-0`
   - `[codegen] CG0001: codegen missing binding for symbol less`

## Last Verified

1. Date: `2026-02-17`
2. Resolution verified by:
   - eliminating `CG0001` for `less` in std test runs,
   - reproducing then clearing a minimal non-test repro using `if ...: less {}` comparator lambdas.
3. Next blocker now surfaced as:
   - `CG0001: call argument count mismatch for value (call 5905 in std::string::type)`
   - tracked in `compiler_blocker_codegen_call_arg_mismatch_string_value.md`.

## Repro

1. Repro was:
   - `npm run test --workspace @voyd/std`
2. Previous halt on missing `less` no longer reproduces.

## Notes

1. Root cause was parser clause handling splitting `if ...: less {}` into `less` plus a stray `object_literal`, which lowered to an unbound identifier use in codegen.
2. Fix implemented in parser colon-clause rewriting to fold trailing object literals into clause values for clause-host forms (`if`, `while`), plus regression tests.

## Acceptance Criteria

1. `CG0001` for missing binding `less` no longer occurs on std test entry.
2. `npm run test --workspace @voyd/std` advances past this point and now fails at a different codegen issue.
3. Full gates pass:
   - `npm run test --workspace @voyd/std`
   - `npm run test --workspace @voyd/compiler`
   - `npm run typecheck --workspace @voyd/compiler`
   - `npm run test --workspace @voyd/cli`
   - `npm run typecheck --workspace @voyd/cli`
