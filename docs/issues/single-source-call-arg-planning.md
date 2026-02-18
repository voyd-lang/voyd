# Ticket: Single-Source Call Argument Planning (Typing -> Codegen)

## Problem

Call argument planning is duplicated across phases:

- Typing resolves overloads/call compatibility and currently performs operator label adaptation in `/Users/drew/projects/voyd/packages/compiler/src/semantics/typing/expressions/call.ts`.
- Codegen independently re-plans args and currently performs similar adaptation in `/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/calls.ts`.

This duplication creates drift risk and can cause phase disagreement (e.g. typing accepts a call shape but codegen rejects it, or vice versa).

## Goal

Have one canonical call-argument planning result, computed once during typing and consumed by codegen.

## Scope

In scope:

- Function calls
- Method calls
- Operator calls
- Labeled parameters
- Optional parameters
- Structural object-argument decomposition used for labeled params

Out of scope:

- Changing language surface syntax
- Reworking overload semantics

## Proposed Design

1. Add a typed call-argument plan artifact to call resolution state.

- Store per call expression id (parallel to call target resolution).
- Plan should encode argument-to-parameter mapping, including:
  - direct argument mapping
  - omitted optional/default-none slots
  - container-field extraction mapping
  - any label normalization needed for operators

2. Move call-argument planning to a shared implementation used by typing.

- Typing remains responsible for semantic validation and plan creation.
- Operator label adaptation should be represented in this canonical plan, not re-derived later.

3. Make codegen consume the typed plan directly.

- Replace independent re-matching logic with plan materialization.
- Keep codegen-side validation minimal and structural (e.g. defensive asserts for malformed plans).

4. Remove duplicated operator adaptation logic from codegen.

- `OPERATOR_NAMES_WITH_INFERRED_LABELS`-style heuristics should not exist in codegen once plan handoff is complete.

## Acceptance Criteria

- No duplicated call-argument matching algorithms across typing and codegen.
- Codegen argument emission for calls is driven by typed plan metadata.
- Existing operator/labeled/optional call tests pass.
- Add regression coverage that would fail if typing and codegen diverge on call argument mapping.
- Remove temporary codegen operator-label adaptation path introduced during bugfix.

## Suggested Tests

- External trait default operator methods with labeled rhs params (cross-module).
- Same-module operator overload methods with labeled params.
- Mixed labeled + optional params where positional arg follows omitted optional.
- Structural object argument satisfying labeled parameter runs.

## Risks

- Plan format mismatch between typing and codegen could introduce new runtime/codegen failures.
- Existing fallback behavior in call matching may need explicit representation in the plan.

## Migration Notes

- Land behind internal refactor only; no user-facing language change expected.
- Keep old codegen planner temporarily behind assertions during transition, then delete once green.
