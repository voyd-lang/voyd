# Borrowed Array Element Views For Wide Values

Status: Proposed
Owner: Language + Compiler Architecture Working Group
Scope: optimized IR/codegen-view lowering, stdlib container accessors, optional future language surface

## Goal

Eliminate unnecessary owned copies of wide `val` elements loaded from `Array<T>` and
`FixedArray<T>` when the use site only needs a readonly view.

CTX: after landing [`wide-value-abi-and-implicit-borrows.md`](./wide-value-abi-and-implicit-borrows.md),
`voyd_examples/src/vtrace_fast.voyd` improved, but the benchmark is
still materially slower than the TypeScript renderer. The remaining hot path is:

```voyd
let sphere = world.at(index)
let center = sphere.center
let radius = sphere.radius
...
rec.albedo = sphere.albedo
```

Today, `sphere` still tends to materialize as an owned `Sphere` value. For a wide value,
that is exactly the work we want to avoid.

This proposal keeps source semantics unchanged and introduces an internal borrowed-view
lowering for container element reads.

## Why This Proposal Exists

The current wide-value ABI work solved one major class of overhead:

- wide params no longer eagerly copy at function entry
- wide `~params` lower to caller-owned mutable storage
- wide returns use out storage instead of heap boxes

That was enough to make `Ray` and `HitRecord` viable again in `vtrace_fast`.

It was not enough to solve wide container element access. The current problem is more
specific:

1. `Array::at` is source-typed as returning `T`.
2. `T` is a semantic value, not a borrow.
3. For wide `T`, `world.at(index)` often lowers as an owned materialized `Sphere`.
4. The hot loop immediately performs readonly field reads from that value.

This means we still pay copy cost for code that operationally wants:

- a stable pointer to the array slot
- readonly field access through that pointer
- maybe a non-`~self` method call on the same projected element

The compiler already has most of the machinery needed:

- wide-value storage-ref bindings exist in [`locals.ts`](../../packages/compiler/src/codegen/locals.ts)
- field reads already know how to load through a borrowed storage ref in
  [`objects.ts`](../../packages/compiler/src/codegen/expressions/objects.ts)
- owned materialization already has an explicit fallback path via `materializeOwnedBinding`

What is missing is a way to keep a container element read in borrowed form long enough
for those existing code paths to use it.

## Non-goals

- Changing source-level value semantics into reference semantics.
- Introducing general first-class borrow types in this proposal.
- Making every `Array.at` call borrowed.
- Solving mutable borrowed container elements in the MVP.
- Designing a full alias-analysis framework for all heap objects.
- Extending this optimization across opaque boundaries where container identity or
  mutation cannot be controlled.

## Decision Summary

The MVP should be compiler-first and syntax-preserving.

### MVP decision

When a wide value is loaded from an addressable container element and every use of that
result is borrowable, the compiler should lower the result as a readonly borrowed element
view instead of eagerly materializing an owned copy.

This includes the benchmark-shaping pattern:

```voyd
let sphere = world.at(index)
let center = sphere.center
let radius = sphere.radius
```

If a later use demands ownership, the compiler must materialize exactly one owned copy at
that point and rewrite later ownership-demanding uses to the owned storage.

### Language-level decision

The MVP does **not** add new surface syntax.

The language-level position is:

- existing code such as `world.at(index)` should optimize better without source changes
- source semantics remain value semantics
- explicit borrow syntax remains deferred

If we later need a predictable user-facing escape hatch, it should be a narrow readonly
container API such as `borrow_at` or a borrowed iterator, not a general borrow system.
That follow-up is intentionally deferred until the implicit lowering proves its value.

## Principle

Separate semantic value reads from physical value materialization.

`world.at(index)` still means “read the value at this slot”.

However, when the compiler can prove the use chain is readonly and non-escaping, it may
implement that read as:

- hold a reference to the underlying element storage
- load fields directly from that storage
- postpone or avoid the owned copy entirely

This is the container analogue of the wide-parameter borrow rule from the existing ABI
proposal.

## Definitions

### Borrowed element view

A borrowed element view is an internal lowering artifact representing readonly access to
one wide value stored inside container storage.

Properties:

- points at an existing array slot
- readonly only in the MVP
- not source-visible
- not storable as a user value
- not returnable from user functions
- may be materialized into owned storage on demand

### Projection root

The projection root is the storage object that owns the element slot, plus the index used
to locate the element.

For the MVP, valid roots are:

- `FixedArray<T>` storage
- `Array<T>.storage`

### Borrow window

The borrow window is the region in lowered IR during which a borrowed element view is
used directly instead of being materialized.

The MVP keeps this narrow:

- single expression chains
- immutable local bindings
- no escape through return, capture, storage, or mutation
- ends before any operation that may mutate or expose the root container in a way the
  compiler cannot prove safe

## Normative Lowering Rules

### Rule 1: wide container reads may stay borrowed

If all of the following are true:

1. the element type is a wide `val`
2. the container root is addressable
3. the use chain is entirely borrowable
4. the borrow window stays within the MVP safety limits

then the compiler should lower the read as a borrowed element view, not as an owned copy.

### Rule 2: immutable local view bindings may remain borrowed

For code of the form:

```voyd
let sphere = world.at(index)
```

the binding `sphere` may lower as a readonly storage-ref-style binding when:

- `sphere` is never mutated
- `sphere` never escapes
- every use of `sphere` is borrowable

This is the primary optimization target for `vtrace_fast`.

### Rule 3: materialize exactly once on first ownership-demanding use

If a borrowed element view encounters an ownership-demanding use, the compiler must:

1. allocate owned local storage
2. copy the projected value into that storage exactly once
3. rewrite later ownership-demanding uses to that owned binding

Examples of ownership-demanding uses:

- `let ~x = sphere`
- passing `sphere` to a wide `~param`
- storing `sphere` into another container
- returning `sphere`
- capturing `sphere` into a closure/effect environment

### Rule 4: readonly borrowed views must not become source-visible aliases

The compiler must never let user code observe aliasing between:

- `sphere` as a borrowed element view
- any other source binding that denotes an independent value

If there is any doubt, the compiler must materialize an owned copy.

### Rule 5: borrowed element views are invalidated by unsafe root exposure

The compiler must end the borrow window and materialize if needed before any operation
that may invalidate the element slot or make aliasing/mutation untrackable.

The MVP invalidation set is conservative:

- mutation of the root container
- passing the root container to a `~param`
- passing the root container to an opaque or unknown callee
- rebinding patterns that would lose the necessary root liveness/storage guarantees

Calls that do not receive the root container or a derived alias do not by themselves
invalidate the borrow window.

## Borrowable Uses In Scope For MVP

These uses should work directly from a borrowed element view:

- field reads from the projected wide value
- passing the projected wide value to a non-`~` wide parameter
- calling a non-`~self` method on the projected wide value
- binding the projected wide value to an immutable local that itself remains non-escaping
  and readonly

These uses are explicitly out of MVP:

- `~self` method calls through the projected element
- mutation through the projected element
- returning a borrowed element view across a function boundary
- storing a borrowed element view into another binding or data structure as a borrow

## Concrete Design

### 1. Introduce an internal projected-borrow fact

Add a new internal representation in the optimized codegen path for “wide value located
at container slot”.

This can be modeled in one of two ways:

- a dedicated `projected-ref` binding kind
- or, preferably, by reusing the existing `storage-ref` binding form with a stabilized
  pointer to the element storage

The preferred design is to reuse `storage-ref` and store the element-storage reference in
an internal temp local. That keeps downstream field access and call-argument lowering
aligned with the existing wide-borrow machinery.

### 2. Recognize stdlib array accessors as projection sources

The optimizer/codegen-view pass should recognize exact-target calls for:

- `FixedArray` element reads
- `Array.at`
- `Array.get` where the optional payload is then read immediately

For MVP, `Array.at` is the critical case.

This recognition should happen in the compiler pipeline, not by hard-coding typing
internals into Wasm emission. Codegen should consume a lowering fact that already says
“this expression may remain borrowed”.

### 3. Stabilize the projection root

When lowering a borrowed element view, the compiler must keep alive:

- the storage object containing the element
- the computed slot reference or storage pointer needed for field reads

For `Array<T>`, this means stabilizing `self.storage` before projecting the element.

### 4. Reuse existing storage-ref consumers

Once a projected element is bound as a readonly storage ref:

- field reads should go through the existing borrowed field-load path in `objects.ts`
- wide non-`~` call arguments should reuse the existing borrowed-argument path
- first ownership-demanding use should reuse owned-materialization logic from `locals.ts`

This is the main reason to build on existing storage-ref machinery.

### 5. Keep the initial borrow window deliberately narrow

The first implementation should support:

- direct projection chains such as `world.at(index).center`
- immutable locals initialized from a projected read, such as
  `let sphere = world.at(index)`
- subsequent readonly field reads and non-`~self` calls on that binding

Do not try to solve:

- cross-branch projection merging
- mutable projected borrows
- complicated alias interactions
- arbitrary interprocedural borrow propagation

## Pipeline Placement

This should be implemented after semantic/codegen-view construction and before final Wasm
emission, alongside the current optimized lowering decisions.

The key boundary rule remains:

- semantics/type arena stay source-semantic
- codegen consumes explicit lowering facts

This proposal should not require codegen to rediscover alias facts from raw typed syntax.

## Safety Model

The MVP safety model is conservative by design.

A projected borrow is allowed only when all of the following hold:

- the root container is known exactly enough to find the storage slot
- the borrow window is local and bounded
- no operation in that window may mutate or escape the root container
- no source-visible alias can be produced from the borrowed view

If any condition fails, the compiler falls back to owned materialization.

## Alternatives Considered

### Alternative A: add `borrow_at` now

Rejected for MVP.

Reason:

- it adds user-visible API surface before we know the right borrow model
- it leaks a low-level performance concern into common source code
- the benchmark shape should be fixable without changing user code

This remains a valid follow-up if users need a predictable escape hatch.

### Alternative B: special-case only `world.at(index).field`

Too narrow.

It would help one benchmark shape, but not:

- local readonly views
- non-`~self` method calls on projected wide values
- reuse of the same projected element across multiple field reads

### Alternative C: general borrowed returns for arbitrary functions

Too large for this problem.

Borrowed container-element views are the high-value narrow case. General borrowed return
ABI would require much broader lifetime and alias rules.

## Implementation Plan

### Phase 1: representation and recognition

1. Add a projected-element lowering fact in the optimized compiler/codegen-view path.
2. Recognize exact-target `Array.at` and `FixedArray` get-like reads for wide value
   elements.
3. Lower direct field reads from those projections without owned materialization.

Deliverable:

- `world.at(index).center` can lower through the container slot directly.

### Phase 2: immutable local borrowed views

1. Extend local-binding lowering so `let sphere = world.at(index)` may produce a
   readonly storage-ref-style binding instead of an owned local.
2. Teach identifier/field/call lowering to consume that binding as borrowed.
3. Reuse `materializeOwnedBinding` when the local later encounters an ownership-demanding
   use.

Deliverable:

- the current best source shape in `vtrace_fast` stops copying `Sphere` eagerly.

### Phase 3: safety barriers and fallback correctness

1. Add invalidation checks for root-container mutation or unsafe escape.
2. Add tests for fallback-to-owned behavior.
3. Confirm that readonly borrows do not become source-visible aliases.

Deliverable:

- correctness-preserving fallback behavior under mixed use patterns.

### Phase 4: benchmarking and follow-up scope

1. Re-run `vtrace_fast` against TypeScript.
2. Measure direct field chains versus immutable local-view bindings.
3. If the result is still not close enough, evaluate whether the next step should be:
   - borrowed iteration helpers
   - explicit `borrow_at`
   - container layout refinements beyond this proposal

## Testing Plan

Add compiler and smoke coverage for:

- readonly field reads from `Array<WideValue>.at(index)`
- immutable local binding from array element followed by multiple field reads
- fallback materialization when the local is passed to `~param`
- fallback materialization when the local is returned
- non-`~self` method calls on projected wide values
- regression coverage for `vtrace_fast`

The canonical benchmark check remains:

- `/Users/drew/projects/voyd_examples/src/vtrace_fast.voyd`

## Expected Impact

This proposal should reduce the remaining wide-value container-read penalty without
changing source ergonomics.

Expected qualitative result:

- `Ray` and `HitRecord` keep the wins from the existing wide-value ABI work
- `Sphere` no longer pays a mandatory owned-copy cost in readonly hot loops
- `Array<WideValue>` becomes much closer to the intended “inline storage plus borrowed
  reads” model from the original value-types design

This is the most direct next step for closing the remaining `vtrace_fast` gap.
