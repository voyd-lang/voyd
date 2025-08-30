# Semantics and Type System Refactor Plan (Incremental)

The aim is to make the type system simpler and more predictable by:
- Separating type AST from value AST
- Using compact, canonical type expressions
- Reducing over-eager cloning/specialization

This revised plan slices the work into smaller, verifiable phases with crisp success criteria and feature flags where helpful. The full Map-from-tuple-literals example remains a final validation, not an early gate.

## Guiding Principles

- Small steps: each phase produces a safe, reviewable PR with narrow scope.
- Separation: never embed value ASTs inside type expressions.
- Canonicalization: prefer compact, canonical type-exprs derived from resolved types.
- Laziness: resolve only what’s needed early; specialize bodies later.
- Stability: preserve error messages and behavior unless explicitly called out.

## Current Symptoms and Root Causes

- Runaway clones and stack overflows when deep value trees leak into structural type-exprs and then into generics.

---

## Phase 0 — Baseline Metrics and Guardrails

- Scope: add or confirm debug toggles and basic metrics; no behavior changes.
- Changes:
  - Ensure `VOYD_DEBUG_CLONE` and `VOYD_DEBUG_INFER` logs provide short, useful summaries.
  - Optional shallow cycle guard in `clone()` for development builds.
- Success:
  - Can capture short clone/infer profiles for representative files.
  - Test suite passes with zero semantic changes.

---

## Phase 1a — Canonicalizer Utility (Types → Type-Expr)

- Scope: introduce a canonicalizer to turn resolved Types into compact type-exprs.
- Changes:
  - Utility returns identifiers for primitives/nominals/aliases; shallow structural shapes for structural types.
  - No wiring into the pipeline yet.
- Success:
  - Unit tests cover primitives, aliases, simple structural forms.
  - No behavior changes; zero E2E impact.

---

## Phase 1b — Safe Wiring: Object Literal Fields (Trivial Cases)

- Scope: when building structural types from object literals, set `field.typeExpr` from `field.type` via canonicalizer — only for trivial cases (primitives, nominal objects, and aliases).
- Flag: default on.
- Success:
  - No change in behavior or diagnostics.
  - Clone metrics do not worsen.

---

## Phase 1c — Shallow Structural Canonicalization (Opt-in)

- Scope: extend canonicalization to shallow structural shapes used in object/tuple literals (e.g., `{ a: i32 }`, `(String, i32)`), but behind a flag.
- Flag: `VOYD_CANON_STRUCT=1` (off by default).
- Success:
  - With flag on, selected e2e tests exercise structural literals without regressions.
  - With flag off, identical behavior as today.

---

## Phase 2 — Lightweight `typeArgs` (Foundations)

- Scope: establish a rule that `call.typeArgs` carry expressions, not deep Type graphs.
- Changes:
  - Add validation/guards to prevent Type instances in `typeArgs` construction.
  - Preserve alias identity for readability while `alias.type` holds the resolved Type.
- Success:
  - Unit tests confirm `typeArgs` stay expression-only.
  - No change in selected overloads.

---

## Phase 3 — Array Literal Lowering Hygiene (Step 1)

- Scope: ensure lowering to `new_array`/`FixedArray` never embeds Types into exprs and prefers type hints when available.
- Changes:
  - Use expected element-type hints when provided (e.g., parameter `Array<T>`), without forcing specialization timing elsewhere.
  - Avoid holding references that trigger re-resolve/clone loops.
- Success:
  - Unit tests for nested arrays of primitives and tuples; no clone storms.
  - No behavior changes.

---

## Phase 4 — Lazy Specialization (Objects First)

- Scope: signature-only specialization for object init/impl methods during candidate discovery.
- Changes:
  - Defer body resolution until after candidate selection.
- Success:
  - Reduced work on generic-heavy files; no change in selected overloads.

---

## Phase 5 — Lazy Specialization (Functions, Expanded)

- Scope: extend lazy specialization to function overloads so we avoid resolving generic bodies during candidate discovery.
- Changes:
  - Added signature-only generic instance creation using bound type aliases (no body resolution) via `resolveGenericsWithTypeArgsSignatureOnly`.
  - Candidate filtering resolves signatures for comparison and resolves only the selected winner fully.
  - Decision: keep generic expansion using full specialization for now due to a FixedArray param resolution edge case; signature-only expansion remains available for future gating once the edge case is addressed.
- Tasks:
  - Signature-only specialization utility for functions (done).
  - Candidate filtering resolves only signatures; winner resolves body (done).
  - Tests: ensure non-selected generic functions are not fully resolved (done).
  - Tests: trait-object discovery does not prematurely resolve unrelated impls (done).
- Success:
  - Overload results unchanged; non-selected generics remain unresolved in discovery tests; trait-object path remains lazy.

Notes
- Rationale for deferring signature-only expansion in getCallFn: a regression was observed when specializing `new_fixed_array<T>(size: i32)` using only signature info in expansion; parameter types formatted as `unknown` in error reporting under certain module contexts. Keeping full expansion in the expansion step avoids the regression while preserving laziness because only the ultimately selected candidate resolves its body.
- An opt-in `VOYD_LAZY_FN_EXPANSION` flag is now available to switch candidate expansion to signature-only with a safe fallback to full expansion if no candidates match. Default remains off until we add coverage for FixedArray/Array scenarios.

---

## Phase 6 — Canonicalization On by Default

- Scope: enable structural canonicalization by default (remove `VOYD_CANON_STRUCT` gate).
- Success:
  - No value-level AST embedded in any type-expr.
  - Test suite stable.

---

## Phase 7 — Type Interning and Pretty Printing

- Scope: deduplicate structural shapes and decouple error messages from internal `typeExpr` trees.
- Changes:
  - Intern frequent structural shapes; add pretty-printer used by diagnostics.
- Success:
  - Fewer duplicate Types in memory (spot-check via metrics).
  - Diagnostics remain readable and stable.

---

## Phase 8 — Safer Cloning Policies

- Scope: reduce accidental deep copies and guard against cycles.
- Changes:
  - Optional shallow-clone for Types where safe; development-only cycle detector.
- Success:
  - No observed clone storms with debug metrics enabled; zero regressions.

---

## Final Validation — End-to-End Map/Html/MsgPack Scenarios

- Map tuple construction (String keys/values inferred) compiles and runs.
- HTML/JSON and MsgPack encoder scenarios compile and run without stack overflows.

---

## Test Strategy (Per-phase)

- 0–1a: Unit tests only; no E2E changes.
- 1b: E2E smoke on objects using primitive/nominal fields; snapshots stable.
- 1c: E2E gated by `VOYD_CANON_STRUCT`; compare on/off behavior.
- 2: Unit tests that inspect `typeArgs` payloads.
- 3: E2E with arrays and nested arrays; ensure no deep Type leakage.
- 4–5: Targeted E2E on overload-heavy/generic-heavy files; compare candidate selection logs.
- 6–8: Full suite and performance smoke tests.

---

## Rollout & Risk Management

- Ship small PRs per sub-phase; keep flags for opt-in changes until stable.
- Risks:
  - Diagnostic diffs: mitigate with pretty-printer (Phase 7) and snapshot updates.
  - Specialization order sensitivity: keep enumeration deterministic and prefer signature-only artifacts until selection.
---

## Phase 9 — Candidate Enumeration & Determinism

- Scope: ensure deterministic candidate order and stable behavior.
- Changes:
  - Stabilize enumeration order (receiver methods prioritized in method position; otherwise preserve lexical/module order).
  - Use stable keys for deduplication and deterministic tie-breaking in ambiguous errors.
- Tasks:
  - Audit candidate enumeration and add secondary sort when needed.
  - Add unit tests to assert deterministic ambiguous-error text and candidate sets.

---

## Diagnostics & Developer Ergonomics

- Add targeted tests per phase (done for 1a, 1c, 3, 4, 5; more to add for 9).
- Document env flags and defaults:
  - VOYD_CANON_STRUCT: off by default (turn on to canonicalize structural field types).
  - VOYD_ARRAY_LIGHTARGS: off by default (turn on to pass lightweight array element type-args).
  - VOYD_LAZY_FN_EXPANSION: off by default. When on, getCallFn expands generic candidates using signature-only specialization during candidate discovery, with a fallback to full expansion if no candidates match. Useful to experiment with Phase 5 laziness.
- Provide a maintainer guide for canonicalization rules, lazy specialization, and array-lowering hygiene.
