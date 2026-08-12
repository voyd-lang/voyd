# Independent Assessment of `val`

Status: Investigation

Date: 2026-08-10

Scope: the current `val` language feature, its interaction with the proposed
scoped explicit borrow model, and plausible replacement designs.

This assessment was performed independently. The existing
`val-removal-investigation.md` report was deliberately not read or used.

## Recommendation

Keep `val`, but narrow the ambition of the feature.

Voyd should retain the core source contract:

- a nominal aggregate with no observable identity;
- field-wise logical copy semantics;
- explicit mutation through `~`;
- a predictable compact representation for small fixed-layout values.

Voyd should not remove `val` today. Existing object optimizations replace its
performance well for supported non-escaping locals, but they do not replace it
for container-stored records. In a controlled repository benchmark, changing only
three small `val` declarations to `obj` made the release-optimized lookup stage
2.64 times slower. The non-escaping response stage remained at parity. This is
strong evidence that optimization is already a good complement to `val`, but
is not yet a complete substitute.

The compiler should instead investigate a smaller `val` implementation:

1. Keep direct-lane lowering for small values.
2. Reconsider the optimized wide-value ABI as a separately justified
   optimization, not part of the minimum language feature.
3. Reconsider direct unions of `val` variants, which have no non-test use in
   this repository and add a separate inline-union representation.
4. Continue improving ordinary `obj` scalar replacement and exact-layout
   lowering where those optimizations benefit all code.
5. Consolidate aggregate representation planning so `val` and scalarized
   `obj` code share lowering mechanisms without sharing semantic rules.

A full removal should be reconsidered only after an object-based prototype
closes the container benchmark gap, an explicit copy/clone migration is
accepted, and an implementation diff demonstrates a meaningful net compiler
simplification rather than moving the same representation state into the
optimizer.

## Direct answers

### 1. Can simpler features or optimizations replicate the performance?

Partly.

- Existing escape analysis and scalar aggregate replacement already replicate
  `val` performance for supported non-escaping shapes, including the record
  measured in this investigation.
- They do not currently replicate compact container records, predictable
  cross-call lowering, or the unoptimized performance of `val`.
- More object optimization can plausibly close those gaps, but preserving
  object identity while changing representation requires proofs and
  materialization boundaries. That is not inherently simpler than keeping an
  explicit no-identity type category.
- A compact or final object representation could match much of the container
  performance while preserving object identity. It would not replace `val`
  copy semantics.

### 2. How significantly would removal reduce compiler complexity?

Removal would produce a material codegen simplification if Voyd accepts
ordinary object performance and alias semantics as the replacement. It would
produce a much smaller net simplification if Voyd still requires the current
performance characteristics.

A static scan of production compiler TypeScript found:

- 61 files that explicitly distinguish `value-object` or
  `objectKind: "value"`, with 205 direct marker occurrences;
- 24 files participating in the wide `readonly_ref`/`out_ref` or projected
  element paths, with 105 direct marker occurrences;
- 187,003 total production TypeScript lines in `packages/compiler/src`;
- 1,410 lines in `projected-element-views.ts`, a file shared by wide-value
  projection optimization and runtime place-identity support.

The 61- and 24-file sets overlap. Marker counts are a measure of breadth, not
deletable lines.

Without a prototype deletion, my rough implementation estimate is:

- full removal while accepting ordinary `obj`: roughly 2,000-5,000 net
  production lines removed or materially simplified, around 1-3% of the
  compiler;
- retaining small direct values while dropping the optimized wide-value path:
  roughly 1,000-3,000 lines of potential simplification;
- full removal while rebuilding equivalent object performance: an uncertain
  and probably modest net reduction, because compact-object planning,
  identity preservation, escape proofs, and boundary materialization replace
  much of the deleted machinery.

The state-space reduction is more important than the percentage of total
lines. Today codegen combines direct lanes, boxes, readonly references,
mutable references, and out results with calls, defaults, closures, effects,
trait dispatch, containers, unions, control flow, and mutation.

### 3. Does `val` have important behavior that lacks a better replacement?

Its behaviors can be recreated individually, but no clearly simpler
alternative recreates the complete contract.

- Explicit `copy` or `clone` can replace occasional copy behavior, but changes
  assignment and parameter semantics and does not provide compact layout.
- An immutable record or `struct` with implicit copies can replace `val`, but
  is the same semantic type category under a different name.
- Copy-on-write objects can preserve value-like assignment, but add runtime
  state, uniqueness checks, and clone paths.
- Optimizations can remove allocations and copies, but cannot change the
  observable alias behavior of `obj`.

The important irreducible contract is the combination of no identity and
logical copy independence. That contract is what lets the compiler choose
lanes, boxes, or physical borrows without proving that user code cannot observe
object aliasing.

## What `val` actually provides

`val` currently bundles three concerns.

### Source semantics

A `val` is nominal and can have methods, generic parameters, visibility, and
trait implementations. Unlike `obj`, it:

- has no observable identity;
- is logically copied on assignment, plain argument passing, return, and
  capture;
- cannot inherit;
- cannot implicitly widen to a trait object;
- cannot recursively contain an inline `val` layout;
- requires an addressable `~` root for mutation.

The copy is field-wise, not an arbitrary deep clone. Nested `val` fields remain
values. Object handles and other reference-like fields remain aliases to their
allocations. `HeapHolder` in the conformance fixture exercises the supported
case of a `val` containing an object handle.

The strongest observable example is:

```voyd
let ~original = Vec2 { x: 1, y: 2 }
let copy = original
original.x = 99
copy.x // 1
```

Changing `Vec2` to `obj` changes the result because both bindings then refer to
one allocation.

### Representation contract

The semantic type arena has a distinct `value-object` descriptor. Codegen
flattens value fields into Wasm ABI lanes. Values at or below the four-lane
threshold can travel directly. Addressable or stored values can use a compact
Wasm GC struct without ordinary object RTT, field-table, and method-table
payloads.

The current `Array<val>` representation is not a fully packed struct-of-values
array. `FixedArray` storage uses the value's compact GC box type when an inline
box is required. This means `val` still avoids ordinary object metadata and
can use direct lanes outside storage, but it should not be described as
guaranteeing packed array elements.

Wide values use a more elaborate internal ABI:

- immutable parameters use physical readonly references;
- `~` parameters use mutable references;
- results use caller-provided out storage;
- a copy is materialized only when an ownership-demanding use requires it.

These physical references are compiler artifacts. They do not weaken the
source-level copy contract.

### Optimizer freedom

Because identity is absent, the compiler may:

- share immutable physical storage temporarily;
- scalarize fields;
- rebuild a value after field mutation;
- pass a wide value by readonly reference;
- write a result directly into its destination;
- borrow a container element for a bounded read;
- materialize a copy before mutation, escape, storage, or an opaque boundary.

An `obj` optimizer may perform many of the same transformations, but only after
proving that identity and aliasing remain unobservable for the particular
allocation and use chain.

## Implementation trace

The feature is intentionally unified with objects in some compiler layers and
separate in others.

### Parser, binding, and HIR

`parseObjectDecl` recognizes both `obj` and `val` and records an
`objectKind`. Binding and HIR mostly carry that tag through the ordinary object
declaration path.

This layer is small. Removing the keyword would save little by itself.

Relevant files:

- `packages/compiler/src/parser/surface/declarations.ts`
- `packages/compiler/src/semantics/binding/binders/object.ts`
- `packages/compiler/src/semantics/hir/nodes.ts`
- `packages/compiler/src/semantics/lowering/declarations.ts`

### Type system

The type arena distinguishes `value-object` from `nominal-object`. The type
system adds rules for:

- fixed-layout-compatible fields;
- recursive inline layout rejection;
- inheritance rejection;
- implicit trait-object widening rejection;
- mixed value/object union rejection;
- imported and instantiated value-object preservation.

This is a moderate amount of complexity, but most nominal lookup, member,
generic, constraint, and method behavior is shared with `obj`.

Relevant files:

- `packages/compiler/src/semantics/typing/type-arena.ts`
- `packages/compiler/src/semantics/typing/type-system.ts`
- `packages/compiler/src/semantics/typing/expressions/call.ts`
- `packages/compiler/src/semantics/typing/import-type-translation.ts`

### Codegen

Most unique complexity lives here. It includes:

- recursive ABI-lane flattening;
- compact storage-box generation;
- box/unbox and field-wise transfer cloning;
- direct and inline-union layouts;
- small/wide classification;
- readonly, mutable, and out-reference ABI planning;
- addressable local materialization;
- field rebuilds for value mutation;
- value handling through defaults, closures, effects, control flow, and trait
  wrappers;
- projected wide array-element reads and pre-mutation materialization;
- boundary serialization of both inline and stored representations.

Relevant files:

- `packages/compiler/src/codegen/types.ts`
- `packages/compiler/src/codegen/structural.ts`
- `packages/compiler/src/codegen/locals.ts`
- `packages/compiler/src/codegen/functions.ts`
- `packages/compiler/src/codegen/projected-element-views.ts`
- `packages/compiler/src/codegen/expressions/call/arguments.ts`
- `packages/compiler/src/codegen/expressions/call/trait-dispatch.ts`

### Borrow analysis

Borrow analysis must understand whether a value type can carry object
references and how field projections behave. This is real complexity, but it
is smaller than the codegen representation machinery. Ordinary object access,
`~`, runtime place identity, and `SharedCell` remain even if `val` is removed.

## Controlled performance experiment

### Method

The experiment used
`tests/performance/fixtures/web-app-request-pipeline.voyd` at commit
`3faa6718` on arm64 with Node `v24.18.0`.

The fixture has three value declarations:

- `Route` with three `i32` fields;
- `ProductCard` with four `i32` fields;
- `RequestContext` with four `i32` fields.

The comparison changed only those declaration keywords from `val` to `obj`.
All expected checksums remained equal. Compilation was alternated between
variants after warmup. Runtime samples used warmed hosts and alternated variant
order. Release numbers use `optimize: true`.

These are local architectural measurements, not release claims. Their purpose
is to identify which lowering boundary matters.

### Release-optimized result

| Entry point | All `val` | All `obj` | `obj` delta |
| --- | ---: | ---: | ---: |
| Integrated `main` | 2.864 ms | 3.961 ms | +38.3% |
| `request_lookup_stage` | 0.649 ms | 1.713 ms | +163.8% |
| `response_serialization_stage` | 2.183 ms | 2.182 ms | effectively equal |

The release artifact was 3,926 bytes for `val` and 4,506 bytes for `obj`
(`obj` +14.8%). Gzip sizes were 1,906 and 2,189 bytes respectively. Alternated
compile medians were 1,726.8 ms and 1,728.4 ms, effectively equal for this
experiment.

An isolation run changed only `Route` and `ProductCard` to objects, then only
`RequestContext`:

| `request_lookup_stage` variant | Median |
| --- | ---: |
| All `val` | 0.648 ms |
| Only array record types changed to `obj` | 1.702 ms |
| Only `RequestContext` changed to `obj` | 0.657 ms |
| All `obj` | 1.728 ms |

The optimizer therefore replaces `val` successfully for the non-escaping
request record. The unresolved gap is dominated by records stored in and read
from arrays.

### Unoptimized result

For the focused lookup stage without optimization:

- `val`: 1.048 ms;
- `obj`: 8.411 ms;
- `obj` was 8.03 times slower.

The unoptimized `val` artifact was larger in this case: 53,954 bytes versus
49,942 bytes. The runtime benefit is therefore a representation and access
benefit, not simply smaller generated code.

### Interpretation

The experiment supports four conclusions:

1. `val` is not necessary for every aggregate performance win.
2. Existing object scalar replacement is already effective when the value is
   non-escaping and locally provable.
3. Type-level no-identity information still matters for containers and stable
   cross-boundary representation.
4. Replacing `val` with optimization alone would make performance more
   dependent on escape shape and optimization level.

## Replacement options

| Alternative | Runtime potential | Semantic replacement | Compiler effect | Assessment |
| --- | --- | --- | --- | --- |
| Existing `obj` scalar replacement | Excellent for non-escaping locals and selected direct calls | No; objects still alias | Already substantial and retained either way | Keep as a complement |
| More exact/compact `obj` lowering | Could close array-record and metadata gaps | No; identity and aliases remain | Needs exactness, escape, representation, and materialization planning | Worth prototyping, not yet a replacement |
| Explicit `copy`/`clone` on `obj` | Copies only where requested | Replaces explicit independence, not implicit assignment semantics | Relatively local for concrete objects; generic cloning needs a contract | Good migration tool |
| Immutable nominal record | Can match small `val` | Yes, if identity is absent and copies are implicit | Recreates a value-object category | A rename/redesign of `val` |
| Copy-on-write object | Can reduce eager copies | Can emulate value assignment | Adds runtime uniqueness state and slow paths | More complex for Voyd's GC model |
| Structural object or tuple | Potentially good with new lowering | Loses nominal method/API behavior today | Requires a new structural value representation | Does not remove backend work |
| Make every `obj` value-semantic | Predictable data performance | Removes intentional shared identity and recursive graphs | Large language and runtime redesign | Reject |

### Ordinary object optimization

Voyd's optimizer already contains the right first layer: escape facts, scalar
aggregate replacement, scalar call specialization, and Binaryen cleanup. The
idiomatic vtrace performance fixture deliberately uses `obj` for its vectors
and aggregate records, demonstrating that ordinary object source can perform
well in a large nontrivial program.

This does not make the two source models equivalent. Whole-object assignment
is a materialization boundary for scalarized objects because identity must be
preserved. A `val` reassignment may remain scalar. Container insertion,
closure capture, public calls, dynamic dispatch, and unknown calls also reduce
the optimizer's proof scope.

Extending object optimization through these boundaries risks recreating the
same direct/ref/box state machine with harder proof obligations.

### Compact exact objects

A compact representation for objects that are final, exact, and never used
through dynamic structural or trait boundaries is the most promising
performance substitute. It could remove the three ordinary RTT/table fields
from array record instances while retaining heap identity.

The hard case is representation transition. If a compact object later reaches
a dynamic boundary, codegen must either materialize a general object while
preserving every alias, or conservatively reject compact lowering for the
whole identity. This is an all-alias problem that `val` avoids by definition.

This optimization is still worth pursuing because it improves normal `obj`
code. It should earn its complexity independently rather than being assumed to
make `val` redundant.

### Explicit copies

An explicit operation can replace the small amount of production code that
needs actual copy independence:

```voyd
let independent = original.copy()
```

This is clearest when copies are rare. It is less suitable for generic numeric
code, where every ordinary assignment and argument currently has value
semantics. It also needs a precise rule for field-wise copying. A shallow object
clone is not identical to `val` when nested values are present, while an
unbounded deep clone is not the current behavior either.

### A replacement record feature

A nominal immutable record could be a better user-facing data abstraction if
Voyd also wants derived equality, hashing, serialization, and update syntax.
Those features are not provided by `val` today.

If such a record has no identity and implicit value copies, however, the
compiler still needs a semantic value category and most small-value lowering.
It may be a better product design, but it is not a compiler-complexity removal.

## Important behavior and migration impact

### Logical copy independence

This is the main feature that optimizations cannot supply for `obj` without
changing semantics. It matters for mutable numeric values and stateful values
such as `LocalRng`: two copied generators can evolve independently.

An explicit clone is a valid alternative if Voyd chooses explicitness over
implicit copy semantics. That is a language tradeoff, not a transparent
migration.

### Predictable performance across boundaries

`val` gives the compiler layout knowledge in generic instantiations, arrays,
unions, package interfaces, and unoptimized builds. An optimizer gives a
conditional result that may disappear when a value starts escaping or crosses
an unknown call.

Predictability is valuable for the intended vectors, points, colors, and
intervals even when peak optimized performance can be matched another way.

### No identity

No identity is both a user-facing semantic choice and a compiler proof. It
prevents graph-like use, shared mutable state, implicit trait-object widening,
and inheritance. In return, codegen does not need to preserve alias identity
when it splits or rematerializes the value.

### Nominality and methods

Tuples and structural objects do not replace nominal API design. The current
production uses include `LocalRng`, canvas `Point` and `Transform`, and the
Voyd Orbit `Vec2`. They benefit from stable nominal API names; `LocalRng` and
`Vec2` also use method-heavy APIs.

### Features that are less essential

The current repository gives weaker evidence for:

- direct unions whose members are all `val` types;
- optimized wide-value direct/ref/out ABIs;
- wide projected element views beyond conformance and performance fixtures.

After the scoped-borrow proposal removes `ArrayViewCursor`, the standard
library has three public `val` declarations: `LocalRng`, `Point`, and
`Transform`. The repository example adds `Vec2`. `Transform` is the only one
of these that exceeds four scalar ABI lanes. Most broad wide-value coverage is
in tests.

This usage pattern supports narrowing before removal.

## Interaction with scoped explicit borrows

The scoped explicit borrow proposal and `val` solve different source-level
problems:

- `Borrow<T>` and `~T` govern bounded access to existing storage;
- `val` governs value identity and copy behavior.

The proposal explicitly retains internal physical borrowing. That is already
how wide `val` parameters and projected array reads avoid copies. Removing
borrowed results, named regions, and borrow-carrying containers does not remove
the need for these internal representation choices while wide `val` remains.

Conversely, removing `val` would not remove:

- `~` parameter and receiver lowering;
- runtime place identity for uncertain projected mutable arguments;
- `SharedCell` callback access;
- escape analysis and scalar replacement for ordinary objects;
- addressable storage and result forwarding used by other aggregates.

The shared architectural opportunity is a single internal aggregate
representation plan. It should say whether a value is in direct lanes,
addressable storage, a readonly physical reference, a mutable reference, or a
heap-identity object. Source borrow checking and source value semantics should
consume or constrain that plan without codegen rediscovering typing internals.

## Complexity-reduction paths

### Path A: remove `val` and accept `obj`

This yields the largest immediate simplification:

- one nominal object descriptor;
- no value-layout validation;
- no implicit copy contract;
- no inline value unions;
- no wide value readonly/out ABI;
- fewer mutation rebuild and projected materialization paths.

It also accepts the measured container regression, changes alias behavior, and
removes the predictable performance escape hatch. I do not recommend it.

### Path B: remove `val`, replace performance first

This requires:

- compact exact object layouts;
- array/object exactness propagation;
- identity-safe scalarization across more calls and storage;
- boundary materialization;
- explicit copy APIs or a new copy contract.

This may improve the language surface, but the compiler simplification is
uncertain. It should be evaluated from a prototype diff, not assumed.

### Path C: retain a small `val` core

This is the recommended path.

Keep small direct values and their logical semantics. Prototype removing or
de-optimizing wide values so that large values use a conservative boxed copy
representation unless a measured workload justifies the optimized
readonly/out ABI. Separately evaluate whether direct value unions are worth
their representation cost.

This preserves the measured benefit for `Route`, `ProductCard`,
`RequestContext`, `Point`, `LocalRng`, and `Vec2`, all of which fit within four
lanes. It asks `Transform` and synthetic wide fixtures to justify the broad
wide-value machinery.

The source rule does not have to expose a backend-dependent lane limit. Voyd
can either define a stable small-value shape limit or allow larger `val`
declarations with a conservative single-reference ABI and no performance
guarantee. The latter preserves semantics with less surface churn, but still
needs correct field-wise copies.

## Decision gates

Before approving complete `val` removal, require all of the following:

1. A same-source object prototype brings the release-optimized
   `request_lookup_stage` to within 10% of the `val` baseline.
2. The unoptimized gap is either closed or explicitly accepted as a product
   tradeoff.
3. The migration for `LocalRng`, canvas data, and `Vec2` specifies exactly when
   copies are independent and whether copying is shallow or field-wise.
4. Generic, array, optional, closure, effect, and package-boundary behavior is
   demonstrated, not inferred from a local scalar-replacement benchmark.
5. The compiler diff removes at least a low-thousands number of production
   lines or a clearly enumerated representation state without adding an
   equivalent object optimization state machine.
6. Runtime and artifact benchmarks cover both non-escaping locals and
   container-stored records.

Until those gates are met, full removal would trade a real semantic and
performance contract for expected simplicity that has not been demonstrated.
