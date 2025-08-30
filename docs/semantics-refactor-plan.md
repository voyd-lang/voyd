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

## Current Symptoms and Root Causes (unchanged)

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

## Phase 5 — Lazy Specialization (Functions)

- Scope: extend signature-only specialization to function overloads.
- Success:
  - Same correctness; lower clone/specialization costs in overload-heavy cases.

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
