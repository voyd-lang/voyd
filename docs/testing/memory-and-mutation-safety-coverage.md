# Memory and mutation safety coverage

This matrix maps the scoped-borrow specification in
`docs/specs/memory-and-mutation-safety.md` to its primary automated checks.
Names are quoted when they are stable enough to search directly.

## Coverage keys

- `B` — compiler borrowing tests under
  `packages/compiler/src/semantics/borrowing/__tests__`
- `T` — compiler typing validation tests
- `P` — parser function-syntax tests
- `G` — compiler code-generation and optimization tests
- `D` — dependency snapshot and package-interface tests
- `CON` — `tests/conformance/manifest.json`
- `STD` — Voyd tests in `packages/std/src`
- `SDK` — SDK public-boundary tests
- `INT` — cross-package integration tests
- `PERF` — the V-500 scoped-borrow benchmark and accepted optimization suites

## Normative rules

| Requirement                                                                                                          | Primary coverage                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Plain values remain independent of their source slot; object-handle copies preserve allocation identity              | `B`; `CON` plain-values and slot-allocation cases                 |
| `~T` is exclusive against overlapping aliases and supports local non-lexical reborrows                               | `B`; `CON` completed/nested reborrow and overlap diagnostics      |
| Fields and stable indices may be proven disjoint locally; uncertain comparable places use bounded identity guards    | `B`; `G`; `CON` identity-guard success and conflict cases         |
| Arguments and defaults evaluate once before call access activates                                                    | `G`; `CON` default-evaluation-order cases                         |
| Ordinary summaries have only whole-parameter modes and three bounded flags                                           | `B` ordinary-mutation-summary unit tests; `PERF` scaling counters |
| Ordinary SCC solving revisits affected callers and creates no projection families or widenings                       | `B` ordinary-mutation-summary SCC test; `PERF` structural gates   |
| Trait declarations bound dynamic calls and implementations fit the declaration                                       | `B` summary-bound and trait-dispatch tests                        |
| Exclusive callables reject potentially overlapping ambient access, unknown callbacks, effects, and suspension        | `B`; `T`; `CON` unknown-callback declaration bound                |
| Reference-bearing ordinary call results are conservatively possible aliases inside an active exclusive scope         | `B` result-alias conflict cases                                   |
| Active exclusive capabilities cannot be stored, captured, returned, suspended, or laundered through plain parameters | `B`; `CON` plain-parameter laundering                             |
| `Borrow<T>` uses normal generic syntax and `borrow T` is rejected                                                    | `P`; `T`                                                          |
| `Borrow` is reserved, has arity one, is invariant, and cannot be nested                                              | `T`; `P`                                                          |
| A borrow is legal only as a complete callable input after normalization, including nested callable inputs            | `T` normalized-position tests                                     |
| Plain places and temporaries form shared scoped borrows for the complete invocation                                  | `B`; `CON` scoped-borrow place, temporary, and optimized cases    |
| Nested shared reborrows are accepted; shared-to-exclusive upgrades are rejected                                      | `B`; `CON` scoped-borrow input cases                              |
| Exclusive scoped access forms only from an exclusive place, exclusive reborrow, or `SharedCell` guard                | `B`; `STD` SharedCell mutation/replacement tests                  |
| Borrowed results, fields, containers, module storage, and ordinary generic erasure are rejected                      | `T`; `B`                                                          |
| Borrow origins survive projections, destructuring, arrays, and values containing object handles                      | `B` scoped-origin projection cases                                |
| Scalars, reference-free values, and stable `StringSlice` results may leave a scoped callback                         | `B`; `STD` stable StringSlice tests; `INT` StringSlice API tests  |
| Borrowed values call only compiler-known operations or explicit Borrow-aware helpers                                 | `T`; `B`; `CON` scoped helper cases                               |
| Ordinary methods, callable adaptation, and open dispatch on borrowed receivers are rejected                          | `T`; `B` borrowed-call boundary cases                             |
| Active borrows cannot be captured or cross effect, task, suspension, host, Wasm, or FFI boundaries                   | `T`; `B`; `G` host/Wasm-boundary tests                            |
| All four `SharedCell<T>` methods use scoped callback parameters and preserve runtime conflict/writeback behavior     | `STD` all methods/conflicts; `CON`; `INT` runtime behavior        |
| Ordinary `Iterator<T>` returns owned values; `ViewIterator` and `Array.view_iter()` are absent                       | `STD`; public SDK/std compile checks                              |
| Internal physical borrowing materializes before ownership becomes observable                                         | `G` wide-value and array-element-view tests                       |
| Exact optimization facts are demand-driven, cached, budgeted, conservative, and acceptance-independent               | `G`; `PERF` optimizer acceptance/fallback counters                |

## Required diagnostics and behavior

| Rejection or behavior                                | Owner                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Shared/exclusive or exclusive/exclusive overlap      | `TY0048`; `B`; `CON`                                                      |
| Exclusive capability escape                          | `TY0049`; `B`                                                             |
| Shared-to-exclusive borrow formation                 | `TY0050`; `B`                                                             |
| Invalid local `Borrow<T>` formation                  | `TY0027`; `T`                                                             |
| Explicit borrow escape, storage, or plain laundering | `TY0051`; `B`; `T`; `CON` plain laundering                                |
| Borrow across an effect or suspension                | `TY0051`; `B`; `T`                                                        |
| Scoped callback escape                               | `TY0051`; `B`; `STD`                                                      |
| Equal dynamic identities                             | deterministic exclusivity panic; `G`; `CON`; `INT`                        |
| `SharedCell` overlap                                 | deterministic panic or typed `SharedCellBorrowError`; `STD`; `CON`; `INT` |

## Performance ownership

`npm run bench:v500` owns the generated ordinary DTO,
explicit-Borrow, and mutation scaling families. The report at
`docs/notes/v-500-scoped-borrows-results.md` records same-machine comparisons,
raw counters, peak memory, optimizer dispositions, runtime, and Wasm size.

The accepted checked-access optimization suites remain responsible for emitted
behavior: stable-field forwarding, fresh mutable aggregate promotion, counted
Array and Range loops, intrinsic Array iteration, and exact iterator
specialization.
