# Type Canonicalization Validator (Phase 3)

## Current Role

`canonicalizeResolvedTypes` now runs purely as a validation pass. It no longer rewrites the IR or attempts to collapse duplicate `Type` instances. Instead, the visitor traverses the resolved module, fingerprints every `VoydRefType`, and records structural collisions so later phases can introduce a real interner.

- **Read-only traversal.** Every `Type`, `Expr`, and metadata list is walked, but no collections are mutated and no references are swapped.
- **Fingerprint tracking.** The pass uses `typeKey` to build a fingerprint map. Whenever two distinct objects share a fingerprint, it records a `CanonicalTypeDedupeEvent`.
- **Diagnostics only.** Callers can supply a `CanonicalTypeTable` to retrieve the recorded events or attach an `onDuplicate` callback for ad‑hoc reporting. No alias registration or metadata merging occurs.
- **Idempotent validation.** Running the validator multiple times is effectively a no-op beyond re-emitting diagnostics; the module object graph remains untouched.

## Workflow Overview

1. **Traversal (`validateExpr`).** Walk every `Expr` in the module, following return types, parameter types, generic instances, trait implementations, and literal fields.
2. **Type validation (`validateType`).** For each `Type`, register the fingerprint, recurse into child types and type expressions, and capture contextual traces for debugging.
3. **Duplicate reporting.** When a fingerprint collision is discovered, the validator records a `CanonicalTypeDedupeEvent`, hydrates an optional issue callback, and (when `CANON_DEBUG` is set) logs a warning that includes the syntax ancestry for both contenders.
4. **Optional table integration.** If a `CanonicalTypeTable` is provided, the pass clears any previous log and replaces it with the collected events so downstream tools can analyse collisions without mutating the table’s cache.

## Integration Points

- `processSemantics` now invokes the validator for its side effects only and returns the original `VoydModule`. Nothing downstream depends on canonical identities yet.
- Unit tests can observe duplicates by either:
  1. Passing `onDuplicate` to accumulate `CanonicalizationIssue` objects (see `canonicalize-resolved-types.test.ts`), or
  2. Supplying a `CanonicalTypeTable` and reading `table.getDedupeEvents()` after validation (used by the e2e harness).
- The validator respects `CANON_DEBUG`, emitting descriptive console warnings without mutating the graph.

## Testing Status

- `src/semantics/types/__tests__/canonicalize-resolved-types.test.ts` now asserts that duplicate fingerprints are detected while the original references remain distinct.
- Canonical north-star suites (`map-recursive-union` variants) are locked behind `test.skip` with explicit “Phase 7” comments. They document the desired post-interner behaviour but intentionally remain inactive while the validator is read-only.
- E2E tests that previously relied on the mutation pass have been marked as future work; they still collect diagnostics (via tables) to monitor how many duplicates exist today.

## Using the Diagnostics

```ts
const table = new CanonicalTypeTable({ recordEvents: true });
const issues: CanonicalizationIssue[] = [];

canonicalizeResolvedTypes(module, {
  table,
  onDuplicate: (issue) => issues.push(issue),
});

console.log(table.getDedupeEvents().length, "duplicate fingerprints detected");
issues.forEach(({ fingerprint, canonicalContext, duplicateContext }) => {
  console.warn("collision", fingerprint, { canonicalContext, duplicateContext });
});
```

The example above keeps the module untouched but provides enough context to reason about which sites are still generating non-canonical copies.

## Looking Ahead

- **Phase 4:** Introduce a real type interner so duplicates are prevented at construction time instead of being diagnosed after the fact.
- **Phase 5–6:** Migrate metadata ownership (Binaryen caches, trait method tables, generic instance lists) to the canonical handles emitted by the interner.
- **Phase 7:** Re-enable the skipped tests and demonstrate that the recursive-union regressions disappear once codegen consumes canonical instances exclusively.

## Historical Context (Pre-Phase 3)

Earlier iterations of `canonicalizeResolvedTypes` attempted to rewrite the AST in place—merging metadata, reparenting generic instances, and updating `expr.type` references. That approach made it difficult to reason about mutation ordering, produced Binaryen cache corruption, and obscured the real sources of duplicate types. Phase 3 deliberately rolled the pass back to a validator so the next phases can rebuild canonicalization on top of a single, well-defined interner.
