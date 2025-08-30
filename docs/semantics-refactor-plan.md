# Semantics and Type System Refactor Plan

This plan aims to make the type system and semantic resolvers simpler, less brittle, and easier to maintain — while improving performance and predictability. As a concrete example, after this refactor the program below should compile and run without special-case hacks or stack overflows:

Example goal: initialize a generic `Map` from an array of tuple literals where both keys and values are Strings.

```
pub fn main() -> i32
  let m = Map([
    ("hey", "hi"),
    ("goodbye", "hey")
  ])
  0
```

Problem summary: we observed stack overflows (clone storms) when structural types (e.g., tuple-shaped ObjectTypes produced from `(k, v)` literals) embed value-level initializers (e.g., `new_string` → `FixedArray` → `copy` → `iterate`) into their type expressions. These deep value trees hitch a ride into type arguments and generic specialization, and then into repeated `clone()` calls, leading to runaway recursion.

This plan re-establishes a strict boundary between value-level AST and type-level AST; it standardizes on compact, canonical type expressions; and it stages lazy specialization so we do less work sooner.

## Guiding Principles

- Simplicity: types should be compact, canonical, and independent of value-level initializer trees.
- Separation: do not embed value ASTs inside type expressions.
- Laziness: specialize bodies only when a candidate is selected; evaluate signatures first.
- Predictability: keep resolution and inference costs proportional to code size, avoiding unbounded recursion.
- Maintainability: favor local, composable passes with clear responsibilities.

## Non-goals

- Changing language syntax or user-facing semantics.
- Rewriting the entire resolver stack at once; this plan is phased and incremental.

## Current Symptoms and Root Causes

- Symptom: `RangeError: Maximum call stack size exceeded` during compilation of code that initializes `Map([("a","b"), ...])`.
- Root causes:
  - Structural types (tuples/objects from literals) use `field.typeExpr = initializer` (value AST), which can be large and self-referential.
  - Calls store heavy `typeArgs` (full Type graphs) that clone recursively.
  - Generic specialization (objects/functions) eagerly clones bodies and impls during inference.

---

## Phase 0 — Instrumentation and Safeguards

- Scope: add targeted logging/metrics and cycle guards to cloning and inference.
- Changes:
  - Add env-gated debug logs for clone/infer hot paths (already partially done via `VOYD_DEBUG_CLONE`, `VOYD_DEBUG_INFER`).
  - Add cycle guards in `clone()` for Type containers (optional, shallow count or seen-set by id).
  - Record simple metrics (max clone depth, clone counts per node kind) during tests.
- Success criteria:
  - Can capture a short “clone profile” for the Map tuple example.
  - No user-visible changes; zero regression in test suite.

---

## Phase 1 — Canonical Type Expressions for Structural Types

- Scope: ensure structural types created from object/tuple literals use canonical, compact `typeExpr`s that do not reference value-level trees.
- Changes:
  - When resolving an ObjectLiteral to a structural ObjectType, set each `field.typeExpr` to a canonical expression derived from `field.type` (e.g., `Identifier("String")`, `Identifier("i32")`, or a shallow structural shape with canonical children), not the initializer.
  - Keep `field.type` as the semantic source of truth.
- Tasks:
  - Add a canonicalizer utility for Types → Expr (identifiers or shallow structural forms).
  - Apply it in `resolveObjectLiteral` for tuple/object literals.
  - Audit equality/compatibility logic to confirm canonical forms don’t affect correctness.
- Success criteria:
  - Map tuple example compiles and runs.
  - No stack overflows in tests that use tuple/object structural types.
  - No regression in error message clarity (accepting minor wording differences).

---

## Phase 2 — Lightweight `typeArgs` on Calls

- Scope: ensure we never embed deep Type graphs in call `typeArgs`.
- Changes:
  - Store only lightweight expressions in `call.typeArgs` (identifiers, shallow generic heads).
  - During specialization, resolve Types from these exprs via `getExprType`; do not rely on cloning embedded Type objects.
- Tasks:
  - Update generic-object and generic-function instantiation to use display-only exprs in aliases while alias.type holds resolved Type.
  - Add guard/validation to prevent Type instances from being inserted into `typeArgs`.
- Success criteria:
  - Measurable reduction in clone counts on generic specialization.
  - No change in selected overloads; all existing generic inference tests pass.

---

## Phase 3 — Lazy, Signature-Only Specialization

- Scope: avoid resolving/cloning bodies during candidate discovery.
- Changes:
  - Split function/object specialization into two phases: signature-only (parameters, returns, headers) and body-on-demand (impl bodies, fn bodies).
  - Register signature-only generic instances first; resolve bodies only for the selected candidate.
- Tasks:
  - Refactor `resolveFn` and object-type specialization to accept a “signature-only” mode.
  - Ensure `get-call-fn` uses signature-only artifacts for candidate filtering.
  - Defer impl method body resolution until a concrete match is chosen.
- Success criteria:
  - Map tuple example compiles without overflows.
  - Reduced compile time for tests that exercise many generic candidates.
  - No behavior change in overload resolution.

---

## Phase 4 — Type Interning and Pretty Printing

- Scope: canonicalize repeated structural shapes and decouple error-message printing from typeExpr trees.
- Changes:
  - Intern common structural shapes (e.g., tuple-of-String) so they are referenced, not deeply cloned.
  - Provide a pretty-printer for Types independent of `typeExpr` so diagnostics remain friendly after canonicalization.
- Tasks:
  - Add an interning table keyed by structural signatures.
  - Add a pretty-printer and migrate diagnostics.
- Success criteria:
  - Fewer duplicates of equivalent structural Types in memory (spot-check via metrics).
  - Diagnostics remain readable and stable.

---

## Phase 5 — Safer Cloning Policies

- Scope: reduce accidental deep copies and guard against cycles.
- Changes:
  - Add optional shallow-clone modes for Types for transient use.
  - Audit `clone()` implementations and parent-pointer handling; add asserts/guards for accidental self-cycles.
- Tasks:
  - Introduce `cloneShallow()` where applicable.
  - Add a debug-only cycle detector in clone for development builds.
- Success criteria:
  - No observed clone storms in map/tuple tests with debug metrics enabled.
  - Zero functional regressions.

---

## Phase 6 — Array Literal Lowering Hygiene

- Scope: make lowering from array literals to `new_array`/`FixedArray` inference-friendly without deep type propagation.
- Changes:
  - Infer `T` from `opts.from: FixedArray<T>` rather than passing deep `typeArgs` through lowering.
  - Ensure lowering never creates parent/child cycles or stores Type instances as exprs.
- Tasks:
  - Tighten `resolveArrayLiteral` to avoid holding references that will re-resolve and re-clone.
  - Add unit tests for nested arrays of tuples with string elements.
- Success criteria:
  - Map tuple example compiles without additional guards.
  - No stack overflows when mixing arrays, tuples, and Strings.

---

## Test Strategy (Cross-phase)

- E2E cases:
  - Map init with numeric and string values.
  - Arrays of tuple literals (primitive ↔ nominal mixes).
  - MsgPack Encoder regressions: `Map<MsgPack>`, `Array<MsgPack>`.

- Unit cases:
  - Inference unification never touches value-level initializers.
  - Equality/compatibility on canonical structural types.
  - Signature-only specialization matches body-specialized result.

---

## Incremental Rollout & Risk Management

1) Land Phase 1 and Phase 2 behind small PRs. Re-run E2E and performance smoke tests.
2) Introduce Phase 3 gradually (function signatures first, then object generics).
3) Add interning and pretty-printer (Phase 4) once canonicalization is stable.
4) Adopt shallow clones and cycle guards (Phase 5) as we touch clone paths.
5) Finalize array-lowering hygiene (Phase 6) with exhaustive tests.

Risks & mitigations:
- Error message changes: mitigate with new pretty-printer and snapshot updates.
- Ordering sensitivity in lazy specialization: pre-register headers and keep deterministic iteration order in candidate enumeration.

---

## Final Success Criteria

- Functional:
  - The Map tuple example (String values) compiles and runs without explicit type annotations.
  - All existing tests pass; no stack overflows on large generic-heavy files.

- Architectural:
  - No value-level initializer trees embedded in type expressions anywhere in the AST.
  - Calls carry only lightweight `typeArgs`; generic specialization uses signature-only artifacts by default.
  - Structural types for literals are canonical and interned where beneficial.

- Maintainability:
  - New contributors can understand the separation between value and type AST in one pass.
  - Debug tooling (metrics, logs) makes it easy to spot clone hotspots.
