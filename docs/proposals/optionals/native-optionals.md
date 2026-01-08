# Optional Fields & Parameters (`?`) — Native Optionals Proposal & Implementation Guide

## Scope

This document proposes how to make “Optional” a first-class (native) concept inside the compiler while keeping the existing surface syntax/semantics intact.

Surface spec: `docs/proposals/optionals/surface-spec.md`.

---

## Motivation (Maintainability + Dev X)

The current feature is ergonomic, but the implementation can easily become fragile if optional behavior depends on scattered checks like:

- matching union member names (`Some`/`None`), or
- recognizing union shapes ad-hoc in typing and codegen.

This has already shown up as regressions where one pipeline stage handles optionals and another forgets (e.g., function type expression optionality, spread coercion, mutability enforcement).

The goal is to:

- Keep user-facing behavior exactly the same.
- Centralize “optional-ness” logic in one place.
- Ensure typing and codegen share the same definition of “Optional”.

---

## Proposal

### A) Keep `?` as an explicit “may be omitted” flag

Treat “may be omitted” as metadata on:

- function parameters (positional + labeled)
- lambda parameters
- function type expression parameters
- object fields

This flag controls omission rules. It should never be inferred from `Optional<T>`.

### B) Introduce a single `OptionalInfo` resolver in the typing layer

Add a dedicated module (example path):

- `packages/compiler/src/semantics/typing/optionals.ts`

API shape (suggested):

```ts
export type OptionalInfo = {
  optionalType: TypeId; // Optional<T>
  innerType: TypeId;    // T
  someType: TypeId;     // Some<T>
  noneType: TypeId;     // None
  // optionally: the structural field id/name for Some.value, etc.
};

export const getOptionalInfo = (
  type: TypeId,
  ctx: TypingContext
): OptionalInfo | undefined => { ... };
```

Requirements:

- Cached by `TypeId`.
- The only place that knows “what counts as Optional”.
- Used by both typing (for defaults/unification/coercions) and codegen (for constructing `Some`/`None` values safely).

### C) Use this strategy (everywhere)

This is the compilers source of truth

**Symbol-based (best long-term):**
   - The stdlib marks `Optional`, `Some`, and `None` with an intrinsic/attribute that the compiler records at import time.
   - The typing layer can resolve `Optional<T>` without scanning unions.

### D) Codegen must not pattern-match on names

Codegen should not hardcode `Some`/`None` string matching. Instead it should:

- ask typing for `OptionalInfo`
- emit `None {}` and `Some { value }` using the resolved types/field layout

This ensures codegen stays correct even if the representation changes (e.g., tagged unions later).

---

## Implementation Guide (Prompt / Checklist)

### Deliverables

1. Surface behavior remains as specified in `docs/proposals/optionals/surface-spec.md`.
2. No codegen or typing logic directly matches on `"Some"`/`"None"` names.
3. Optional defaults/wrapping are implemented via `getOptionalInfo()` (or equivalent single abstraction).
4. Higher-order optionality can’t regress:
   - function type expressions preserve `?` flags
   - unification/assignability respects parameter optionality
5. `npm test` passes.

### Suggested steps

1. **Create `optionals.ts` in typing**
   - Implement `getOptionalInfo(typeId)` and cache results.
   - Add helpers:
     - `isOptionalType(typeId)`
     - `optionalInner(typeId)`
     - `optionalNoneMember(typeId)` (or fold into `OptionalInfo`)

2. **Refactor typing to use `OptionalInfo`**
   - Call typing: missing optional args insert `None` via resolved none type.
   - Coercion: wrap `T` to `Optional<T>` via resolved `Some<T>` and `value` field.
   - Object literals: optional missing fields default via resolved none type.

3. **Refactor codegen to use `OptionalInfo`**
   - `compileOptionalNoneValue` should be driven by OptionalInfo, not by scanning union member names.
   - `coerceValueToType` should use OptionalInfo for `T -> Optional<T>` wrapping.
   - Ensure spreads and other “bulk assignment” paths also run through coercion.

4. **Tests**
   - Keep the existing e2e codegen fixture that defines `Some/None/Optional` locally.
   - Add/keep regressions for:
     - function type expression optional params (HOF calling `cb()`).
     - spread copying into optional fields (must wrap `Some`).
     - mutability checks for labeled params satisfied by structural containers.

### Acceptance examples

- `fn expects(opt: Optional<String>) ...; expects()` errors (missing required).
- `fn expects(opt?: String) ...; expects()` OK; `opt` is `Optional<String>`.
- `fn apply(cb: fn(x?: i32) -> i32) ...; apply(f)` allows `cb()` calls.
- Spreading `{ v: 5 }` into `obj { v?: i32 }` results in `v = Some { value: 5 }` (not a raw `i32`).
