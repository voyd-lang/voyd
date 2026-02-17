# Compiler Blocker: Closure Lowering Produces Invalid Calls/Wasm in Dict-Style Callback Paths

## Summary

We have a compiler/codegen root issue in closure-heavy lowering paths that was worked around in std by rewriting `Dict` transform methods to explicit loops.

The workaround is stable, but we still need to fix the underlying closure/call lowering bug in codegen.

## Why This Ticket Exists

1. During std migration, callback-driven `Dict` implementations (notably merge/map/filter-style patterns with captured state) triggered codegen/runtime failures.
2. Symptoms included:
   - `CG0001` call argument mismatch diagnostics in codegen paths.
   - runtime `unreachable` traps from generated Wasm in serialized/export-heavy flows.
3. Std was unblocked by avoiding those closure-heavy forms in hot `Dict` APIs and using explicit loops instead:
   - `/Users/drew/.codex/worktrees/23bc/voyd/packages/std/src/dict.voyd:194`
   - `/Users/drew/.codex/worktrees/23bc/voyd/packages/std/src/dict.voyd:232`
   - `/Users/drew/.codex/worktrees/23bc/voyd/packages/std/src/dict.voyd:256`
   - `/Users/drew/.codex/worktrees/23bc/voyd/packages/std/src/dict.voyd:275`

## Current State (2026-02-17)

1. Full suite is green with the loop-based workaround.
2. The root compiler bug is still unresolved.
3. We do not yet have a locked, minimal compiler fixture that deterministically fails on current `main` without reintroducing callback-heavy Dict code.

## Suspected Technical Area

Primary suspects are closure call argument planning/coercion and closure `call_ref` emission:

1. `/Users/drew/.codex/worktrees/23bc/voyd/packages/compiler/src/codegen/expressions/calls.ts`
   - `compileCallArgumentsForParams` mismatch path (`call argument count mismatch`)
   - `compileClosureArguments`
   - `compileClosureCall`
   - `compileCurriedClosureCall`
2. `/Users/drew/.codex/worktrees/23bc/voyd/packages/compiler/src/codegen/expressions/lambdas.ts`
3. `/Users/drew/.codex/worktrees/23bc/voyd/packages/compiler/src/codegen/closure-types.ts`
4. `/Users/drew/.codex/worktrees/23bc/voyd/packages/compiler/src/codegen/structural.ts`
   - closure/effect coercion wrappers

## Required Work

## 1) Create a deterministic compiler repro fixture

1. Add a fixture in compiler codegen tests that mirrors the failing shape:
   - callback passed to a method (`each`-style),
   - captured mutable state (`out`/accumulator),
   - callback body performs typed calls with labeled args and/or conflict callback invocation.
2. The fixture must fail on current buggy compiler behavior and pass after fix.
3. Add both:
   - compile-time assertion (no `CG0001` mismatch),
   - runtime assertion (no `unreachable`; correct value result).

## 2) Fix closure call lowering

1. Ensure closure parameter planning remains consistent with lowered closure function signatures.
2. Ensure optional/labeled argument expansion does not diverge between:
   - direct function calls,
   - closure calls,
   - curried closure calls.
3. Validate `call_ref` operand ordering and arity for effectful and pure closures.
4. Add targeted diagnostics including closure signature + resolved arg plan when mismatch occurs.

## 3) Remove workaround pressure

1. After root fix is verified, evaluate whether Dict callback-style implementations can be reintroduced safely.
2. If we keep loop implementations for perf/readability, still retain new compiler regression fixtures to guard the bug class.

## Acceptance Criteria

1. New compiler repro test is added and passes.
2. No `CG0001` call-arg mismatch from the repro path.
3. No runtime `unreachable` from the repro path.
4. Existing suites remain green:
   - `npm test`
   - `npm run typecheck`
5. At least one regression test explicitly exercises closure callback + captured mutable state + labeled arguments.

## Related Tickets

1. `/Users/drew/.codex/worktrees/23bc/voyd/compiler_blocker_codegen_less_binding.md`
2. `/Users/drew/.codex/worktrees/23bc/voyd/compiler_blocker_codegen_call_arg_mismatch_string_value.md`
3. `/Users/drew/.codex/worktrees/23bc/voyd/compiler_blocker_dict_constraints.md`
