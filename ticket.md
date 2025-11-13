# Function Overload Follow-Up

## Summary
The initial overload prototype introduced `HirOverloadSetExpr` nodes, typing-time resolution, and codegen support for resolved calls, but it still lacks binder validation and a way to eliminate overload sets before downstream passes. This leaves obvious gaps (invalid bindings, escaping overload sets, backend brittleness) that must be addressed before we can rely on overloads in user code.

## Problems
- **Binder does not own overload semantics.** Lowering re-discovers overload groups by scanning symbols, so accidental duplicates (e.g., a `let` binding sharing a name with an overload set) silently collapse back to single-symbol identifiers. There are no diagnostics when non-function symbols reuse an overloaded name, and no canonical “overload set” handle to refer to later.
- **Overload sets can escape typing unchanged.** `typeOverloadSetExpr` returns `unknown`, so constructs like `let f = add;` type-check even though neither codegen nor runtime can represent an unresolved overload. The first non-call consumer hits `compileExpression` and throws, producing late, confusing failures.
- **HIR still contains `overload-set` nodes after typing.** Every backend stage (codegen, future optimizers) now has to special-case a node that should only exist transiently. Without a specialization pass that rewrites the callee to the chosen `SymbolId`, the overload machinery leaks into unrelated systems and complicates later work.

## Recommended Fix Plan
1. **Binder-level overload grouping.**
   - While binding, group functions by `(scopeId, name)` and assign each bucket an `overloadSetId` (can be the first symbol or a synthetic ID).
   - Emit diagnostics if any non-function declaration shares that name in the same scope or if two overloads have identical arity/annotation signatures.
   - Export two maps: `overloads: Map<OverloadSetId, BoundFunction[]>` and `overloadBySymbol: Map<SymbolId, OverloadSetId>` so later stages can jump from any symbol to its set without re-discovery.

2. **Lowering + typing alignment.**
   - Update lowering to consult the binder metadata: identifiers with `overloadBySymbol` become `overload-set` nodes that carry the `overloadSetId` rather than raw symbol arrays. Non-overloaded identifiers stay as simple `HirIdentifierExpr`.
   - In typing, reject any `overload-set` expression that is not the callee of a `call` (e.g., throw in `typeOverloadSetExpr`). This keeps invalid programs from reaching codegen, even before we specialize the HIR.

3. **Post-typing specialization pass.**
   - Add a lightweight pass after `runTypingPipeline` that walks the HIR, finds call expressions whose callee is an overload set, and rewrites those callee IDs to a plain identifier referencing the selected `SymbolId` recorded in `TypingResult.callTargets`.
   - After the pass, assert that no `overload-set` nodes remain. Codegen (and future passes) can then drop their special cases.

4. **Regression coverage.**
   - Extend the new `function_overloads.voyd` fixture with negative cases (ambiguous call, escaping overload set) to lock down the diagnostics.
   - Snapshot the binder output to ensure overload metadata and errors are reported at the right stage.

Implementing the above will keep overload logic local to the binder/typing boundary, surface user-friendly errors early, and leave HIR/codegen free of transient node kinds.
