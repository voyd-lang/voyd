# Union Soundness Plan

Goal: Unions are restricted to nominal object variants, with optional same-head variants only when their instantiated payloads are disjoint and runtime tags distinguish instantiations.

## Findings in `src/next`
- Union construction accepts any member shape: `resolveUnionTypeExpr` just interns members (see `src/next/semantics/typing/type-system.ts`) and `TypeArena.internUnion` merely flattens/dedupes (no nominal-only guard, no same-head checks).
- Pattern narrowing treats nominal instantiations covariantly: `nominalInstantiationMatches` uses covariant unification of type args, so `Some<Child>` can satisfy a `Some<Parent>` pattern (unsound for same-head unions).
- Exhaustiveness/match membership relies on structural satisfaction: `unionMemberMatchesPattern` falls back to `typeSatisfies`, so structural members could still be matched even if we ban them at the type level unless construction is tightened.
- Runtime tagging currently uses ancestor tables keyed by `TypeId` and structural ids (`getStructuralTypeInfo`, `buildRuntimeAncestors` in `src/next/codegen/types.ts`). TypeIds include type args, but there is no explicit guard preventing cache reuse across unknown/erased instantiations.

## Actions to enforce the new rules
1) **Restrict union members to nominal objects**  
   - In `resolveUnionTypeExpr` and/or `TypeArena.internUnion`, reject any member that isn’t a nominal object (or an intersection whose nominal component is present).  
   - Add validation in `typing/validation.ts` to ensure existing unions comply, surfacing clear errors.

2) **Allow same-head variants only when instantiations are disjoint**  
   - Detect same-head members in `internUnion` (or a dedicated checker) and ensure type args are fully resolved (no `unknown`).  
   - Compute structural overlap for those instantiations (use `getStructuralFields` or `structuralTypeSatisfies`) and reject overlapping payloads (e.g., `{ x: i32 }` vs `{ x: String }` or compatible supersets).

3) **Make nominal instantiation matching invariant for unions and `match`**  
   - Update `nominalInstantiationMatches`/`unionMemberMatchesPattern` to require exact type-arg equality (or invariant unification) instead of covariant checks.  
   - Ensure `narrowTypeForPattern` and exhaustiveness tracking respect the stricter matching so patterns don’t accidentally cover other instantiations.

4) **Align type satisfaction/unification with the restriction**  
   - Revisit `unifyUnion` and `typeSatisfies` to remove paths that allow structural satisfaction of union members once non-nominal members are banned.  
   - Consider failing early when unions contain `unknown` members or when type args of same-head members are not fully known (to avoid runtime tag collisions).

5) **Runtime tagging sanity**  
   - Confirm `buildRuntimeAncestors`/`makeRuntimeTypeLabel` keep instantiation-specific IDs; add an assertion preventing reuse when type args contain `unknown` or when a union bans that member.  
   - If needed, include a hash of substituted type args in the runtime label to guarantee distinct tags even if a future cache coalesces structural shapes.

6) **Tests**  
   - Add typing tests that reject structural/alias/intersection members in unions and overlapping same-head instantiations.  
   - Add match/typecheck tests to prove invariant same-head matching (`Some<A>` arm does not catch `Some<B>`).  
   - Keep existing nominal union tests passing with the new invariance.
