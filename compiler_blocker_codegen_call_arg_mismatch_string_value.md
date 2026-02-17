# Compiler Blocker: `CG0001` Call Argument Count Mismatch in `std::string::type`

## Summary

After resolving `CG0001` missing binding for `less`, std now fails at a new codegen blocker:

- `CG0001: call argument count mismatch for value (call 5905 in std::string::type): argument/parameter mismatch`

## Current Symptoms

1. `npm run test --workspace @voyd/std` fails during codegen.
2. First hard error:
   - `packages/std/std::__voyd_test_entry__:0-0`
   - `[codegen] CG0001: call argument count mismatch for value (call 5905 in std::string::type): argument/parameter mismatch`

## Last Verified

1. Date: `2026-02-17`
2. Command: `npm run test --workspace @voyd/std`
3. First hard error: call argument/parameter mismatch in `std::string::type`.

## Repro

1. Run:
   - `npm run test --workspace @voyd/std`
2. Observe codegen halt with mismatch diagnostic above.

## Context

1. Previous blocker `compiler_blocker_codegen_less_binding.md` is resolved.
2. This is the next surfaced blocker in the std end-to-end path.

## Acceptance Criteria

1. Codegen no longer reports argument count mismatch for this call site.
2. `npm run test --workspace @voyd/std` advances past this failure.
3. Full gates pass:
   - `npm run test --workspace @voyd/std`
   - `npm run test --workspace @voyd/compiler`
   - `npm run typecheck --workspace @voyd/compiler`
   - `npm run test --workspace @voyd/cli`
   - `npm run typecheck --workspace @voyd/cli`
