# Ticket: Make Expected-Type Propagation and Retyping Explicit (Reduce Cache Poisoning)

## Background
Voyd’s typing pass (`typeExpression`) caches expression types in `ctx.table` on first visit. This is generally good for performance, but it introduces a subtle hazard:

- Some expressions (notably lambdas) often require an **expected type** (context) to infer parameter and return types.
- If a lambda is first typed in a “probe” context (e.g. overload resolution / candidate filtering) with an *unknown* expected type, the lambda will be cached as `unknown`-typed (or insufficiently typed).
- Later, when the compiler reaches the “real” call site with a concrete expected type, the cached lambda type prevents retyping, so inference never benefits from the new context.

We recently worked around this in method-call typing by treating lambda arguments as `unknown` during overload probing and only typing them once a single overload is selected.

## Problem
The current system conflates two concerns:
1. **Memoization**: “we already typed this expression”
2. **Constraint solving**: “typing this expression depends on expected type and should be revisitable”

Because caching is unconditional, expected-type driven inference can be “poisoned” by early passes that type expressions without sufficient context.

## Goals
- Preserve the performance benefits of caching.
- Make it safe to do overload probing / candidate checking without permanently degrading inference.
- Reduce the need for ad-hoc workarounds in specific typing functions (like method calls).

## Proposal (choose one direction)

### Option A: Don’t cache “context-dependent” expression kinds unless expected type is stable
Introduce a predicate like `shouldCacheExprType(exprKind, expectedType)`:
- For lambdas (and possibly other forms like overload sets / partial applications), skip caching when `expectedType` is `unknown` or missing.
- Cache only once a non-unknown expected type is applied (or once the expression is fully resolved).

Pros: Minimal architectural change.  
Cons: Requires carefully identifying which expression kinds are context-dependent.

### Option B: Add a retyping mechanism keyed by “typing context”
Extend the cache key from just `exprId` to `(exprId, expectedTypeKey)` where:
- `expectedTypeKey` is `unknown` vs a normalized type-id (or a small “shape” hash).
- `unknown` can be treated as a weak cache entry that is replaced by stronger entries.

Pros: More principled; avoids special-casing expression kinds.  
Cons: Larger change; may increase memory usage.

### Option C: Two-phase typing for calls (probe then commit), generalized
Formalize the existing workaround into a reusable utility:
- “Probe” pass checks candidate applicability without typing context-sensitive args.
- “Commit” pass types args with expected param types and finalizes substitutions.

Pros: Keeps caching model; isolates probing behavior.  
Cons: Still a workaround; doesn’t help other contexts where expected type arrives later.

## Acceptance Criteria
- A lambda used as a method argument can be inferred without explicit annotations even if overload probing occurs.
- No regression in existing typing tests.
- Add at least one regression test proving that a lambda first seen in a probe context is later inferred correctly when expected type is known.

## Related Files / Areas
- `packages/compiler/src/semantics/typing/expressions.ts` (`typeExpression` caching behavior)
- `packages/compiler/src/semantics/typing/type-table.ts` (cache structure)
- `packages/compiler/src/semantics/typing/expressions/call.ts` (overload probing + expected types)
- Lambda typing: `packages/compiler/src/semantics/typing/expressions/lambda.ts`

