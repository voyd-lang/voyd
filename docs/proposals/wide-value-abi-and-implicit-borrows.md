# Wide Value ABI And Implicit Borrows

Status: Proposed
Owner: Compiler Architecture + Codegen Working Group
Scope: optimized internal ABI, container access lowering, codegen/runtime contracts for `val` types

## Goal

Make wide `val` types performant in hot code without adding new surface syntax.

CTX: We are using /Users/drew/projects/voyd_examples/src/vtrace_fast.voyd as a benchmark
for common hot wasm use cases.

This proposal keeps the existing source-level `val` model and changes only the
physical lowering strategy used by the compiler. The intended result is:

- small values like `Vec3` stay cheap and inline
- wide values like `Ray`, `Sphere`, and `HitRecord` stop paying repeated copy and box costs
- container access for wide values stops materializing full copies on every read
- source semantics remain value semantics

## Why This Proposal Exists

The current `val` implementation is sufficient for small fixed-layout aggregates. It
performs poorly for wide values in call-heavy and container-heavy code.

The current implementation has two main issues:

1. Wide values cross internal call boundaries through an ABI that often spills them into
   aggregate boxes.
2. Wide values stored in containers are frequently materialized as full copied values
   instead of being read through temporary borrows.

The `vtrace_fast` benchmark demonstrates both problems:

- `Vec3` benefits from value semantics.
- `Ray`, `Sphere`, and `HitRecord` are wide and are passed, returned, and loaded
  frequently.
- In practice, reverting those wide hot-path types to heap objects improves performance
  substantially even while keeping `Vec3` as a value.

That means the next step is not "more `val` syntax". The next step is "better lowering
for wide values".

## Non-goals

- Adding new borrow syntax such as `&T` or `&mut T`.
- Changing source-level value semantics into reference semantics.
- Making all values physically inline in all contexts.
- Eliminating all copies everywhere.
- Designing a new public FFI/export ABI in this proposal.

## Principle

Separate semantic ownership from physical representation.

A source-level `val` remains a value semantically:

- assignment produces independent values
- passing a value does not expose aliasing to the callee
- returning a value produces a fresh result value
- mutating one binding does not mutate another binding

However, the compiler is free to implement those semantics using temporary internal
references when it can do so without exposing aliasing.

This is the core answer to the parameter question:

> Should passing a non-mutable value type to a function be a reference internally?

Yes, usually.

For non-mutable value parameters, the compiler should generally pass a readonly reference
to caller-owned storage for wide values instead of eagerly copying into callee-local
storage. That does **not** change the source semantics. It is an internal calling
convention choice.

The callee must still behave as if it received a by-value argument:

- it cannot mutate the caller's storage through that readonly reference
- if it needs owned mutable storage, it must make an explicit local copy in lowered IR
- if the source code rebinds or mutates a local copy, that mutation must happen against
  callee-owned storage, not against the caller's borrowed storage

## Value Categories

This proposal divides value types into two implementation categories.

### Small values

Small values continue to use the current inline ABI.

Examples:

- `Vec2`
- `Vec3`
- short scalar tuples
- other values that fit comfortably into a few machine/wasm lanes

Guideline:

- small values should remain cheap to copy
- small values should remain profitable to return directly
- small values should remain eligible for scalar replacement and inlining

### Wide values

Wide values use borrowed/internal-reference lowering across internal boundaries.

Examples:

- `Ray`
- `Sphere`
- `HitRecord`
- nested values whose flattened representation exceeds the small-value threshold

Guideline:

- wide values should not be repeatedly copied across internal call boundaries
- wide values should not be repeatedly boxed/unboxed to satisfy internal calls
- wide values should prefer addressable storage and hidden references

## Threshold

The compiler already has a notion of "small enough to stay inline" through the current
multivalue lane limit. This proposal keeps the spirit of that split.

Initial rule:

- if a value fits within the existing inline signature threshold, keep using inline ABI
- otherwise treat it as wide and lower through implicit borrows / out-storage

The exact threshold remains an implementation constant, but the architectural rule is:

- inline ABI for small values
- reference-style internal ABI for wide values

## Definitions

This section is normative for the rest of the proposal.

### Semantic by-value parameter

A source parameter declared without `~` is semantically by-value. That means:

- the callee must not be able to observe caller aliasing
- mutating a local copy in the callee must not mutate caller storage
- rebinding in the callee must not affect caller state

Semantic by-value does **not** require eager physical copying at function entry.

### Physical borrow

A physical borrow is an internal lowering artifact that gives codegen temporary access to
existing storage. Borrows introduced by this proposal are:

- readonly borrows
- mutable borrows
- never source-visible
- never storable as user values
- never returnable from user functions

### Owned storage

Owned storage is storage whose lifetime and mutation rights belong to the current lowered
region. Examples:

- mutable local storage created for `let ~x = ...`
- caller-provided out storage for a return destination
- mutable parameter storage for `~param`

### Ownership-demanding use

An ownership-demanding use is a use that cannot be satisfied by a readonly borrow and
therefore requires the compiler to materialize an owned copy of a wide value.

The initial ownership-demanding cases are:

- binding a wide value into a mutable local: `let ~x = wide_value`
- passing a wide value to a `~param`
- calling a `~self` method on a wide receiver that is not already addressable local
  storage
- returning a wide value by source semantics when the current region does not already have
  a valid out destination
- capturing a wide value into a closure or effect environment as an owned payload
- storing a wide value into container or heap field storage as an owned element/value
- any opaque boundary where the compiler cannot prove readonly borrowing is sufficient

### Borrowable use

A borrowable use is a use that can be satisfied by a readonly borrow without changing
source semantics.

The initial borrowable cases are:

- reading fields from a wide parameter
- passing a wide parameter to another non-`~` parameter
- reading fields from a wide local that is already addressable
- reading fields from a wide object field
- reading fields from an addressable container element
- calling a non-`~self` method on a wide receiver

## Normative Lowering Decision Rules

This section specifies the required behavior, not just the intended behavior.

### Rule A: wide non-`~` params are borrowed at function entry

For optimized internal calls, a parameter of wide `val` type declared without `~`
must be lowered as a readonly reference, unless the call is at a boundary that is still
using the legacy ABI.

It must **not** be eagerly copied into callee-local storage at entry.

### Rule B: copy only on first ownership-demanding use

If a wide non-`~` param is only used through borrowable uses, it must remain borrowed for
the full lowered lifetime of that use chain.

If a wide non-`~` param encounters an ownership-demanding use, the compiler must:

1. allocate owned storage
2. copy the current value into that storage exactly once for that owned path
3. rewrite subsequent ownership-requiring uses to that owned storage

The compiler may keep separate borrowed and owned views if profitable, but it must not
perform repeated copies for the same ownership path.

### Rule C: `~` params always lower to mutable refs

For optimized internal calls, a wide `~param` or wide `~self` must lower as mutable
reference to caller-provided storage.

No entry copy is permitted for the normal case, because the source semantics already
require mutation of the caller-provided location.

### Rule D: wide returns use out storage

For optimized internal calls, a function returning a wide `val` must lower to an
out-destination ABI.

The caller is responsible for allocating destination storage. The callee writes directly
into that destination. The callee must not build an intermediate heap box merely to
satisfy the internal return convention.

### Rule E: small values remain direct unless another optimization supersedes it

Small values continue to use the existing direct ABI. This proposal does not require
changing small-value lowering.

### Rule F: readonly borrows cannot become source-visible aliases

Any lowering path that would let user code observe aliasing between a readonly borrowed
param and another binding is invalid and must materialize an owned copy instead.

## Required Invariants

The compiler must preserve these invariants:

1. Two source bindings that denote independent values must remain semantically
independent even if they temporarily share underlying storage through readonly borrows.
2. Mutation may only target addressable owned or mutable-borrowed storage.
3. A readonly borrowed parameter may not be mutated in place by lowered code.
4. A copy created due to an ownership-demanding use must dominate all later uses that
depend on that owned state.
5. No user-visible API may expose an implicit borrow as a first-class value.

## Internal ABI Rules

These rules apply to optimized internal Voyd-to-Voyd calls. They do not require source
syntax changes.

### Rule 1: readonly value params

Source:

```voyd
fn hit(ray: Ray, sphere: Sphere) -> bool
```

Lowered internal ABI when `Ray` and `Sphere` are wide:

```text
fn hit(ray_ref: readonly ptr<Ray>, sphere_ref: readonly ptr<Sphere>) -> bool
```

Semantics:

- source still means "callee receives values"
- physical lowering passes readonly references
- callee reads fields through those references
- if callee needs a mutable local copy, it creates local storage and copies once

### Rule 2: mutable params and `~self`

Source:

```voyd
fn fill(~rec: HitRecord, ray: Ray) -> bool
```

Lowered internal ABI when `HitRecord` and `Ray` are wide:

```text
fn fill(rec_ref: mut ptr<HitRecord>, ray_ref: readonly ptr<Ray>) -> bool
```

Semantics:

- `~rec` already requires addressable caller storage semantically
- lowering `~rec` as a mutable reference is the natural implementation
- `ray` remains readonly unless explicitly copied

For methods:

```voyd
impl HitRecord
  fn set_face_normal(~self, ray: Ray, outward_normal: Vec3)
```

Lowered internal ABI:

```text
fn set_face_normal(self_ref: mut ptr<HitRecord>, ray_ref: readonly ptr<Ray>, outward_normal: Vec3)
```

### Rule 3: wide value returns

Source:

```voyd
fn scatter(...) -> HitRecord
```

Lowered internal ABI when return type is wide:

```text
fn scatter(out_ref: mut ptr<HitRecord>, ...) -> void
```

Semantics:

- caller allocates destination storage
- callee writes fields directly into caller-provided destination
- source semantics remain "returns a value"

This removes repeated return boxing and aggregate reconstruction.

### Rule 4: small returns remain direct

Source:

```voyd
fn reflect(self, normal: Vec3) -> Vec3
```

If `Vec3` is small, keep direct return:

```text
fn reflect(self: Vec3, normal: Vec3) -> Vec3
```

## Borrow Model Without New Syntax

This proposal introduces implicit compiler borrows, not explicit language borrows.

The compiler may create temporary readonly or mutable borrows in lowered IR when the
source program already implies safe access to existing storage.

### Readonly implicit borrows

The compiler may create readonly borrows for:

- wide value arguments passed to non-`~` parameters
- reading a wide value from an addressable local
- reading a wide value field from an object or other addressable aggregate
- container element reads when the element storage is addressable
- wide receiver method calls with non-mutable `self`

### Mutable implicit borrows

The compiler may create mutable borrows for:

- `~self`
- `~param`
- addressable local bindings used as mutable value roots
- out-parameter destinations for wide returns

### No source-visible borrow values

Important constraint:

- users do not get first-class borrow values from this proposal
- borrows are not storable in user variables
- borrows are not returned from user functions
- borrows are temporary lowering artifacts only

This keeps the surface language unchanged.

## Copies: When They Still Happen

The compiler should not copy wide values eagerly into params. It should copy only when
needed to preserve semantics.

### Copy is not required

```voyd
fn len(ray: Ray) -> f64
  ray.direction.len()
```

If `ray` is wide, this should lower as readonly borrow access. No copy needed.

### Copy is required

```voyd
fn tweak(ray: Ray) -> Ray
  let ~local = ray
  local.direction = local.direction.unit_vector()
  local
```

Lowering rule:

- incoming `ray` may arrive as readonly ref to caller storage
- `let ~local = ray` requires owned mutable storage
- compiler creates callee-local storage and copies once into `local`
- subsequent mutation occurs against that local storage

This is the key rule:

- wide value params should be **borrowed by default**
- wide value params should be **copied on first need for owned mutable storage**

That gives the right semantic behavior without paying unconditional entry-copy costs.

## Ownership-Demanding Operation Matrix

This matrix is normative for the first implementation.

| Source operation                         | Wide non-`~` param                                                         | Required lowering                             |
| ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Read field (`ray.origin`)                | borrowable                                                                 | readonly borrow                               |
| Pass to non-`~` param                    | borrowable                                                                 | readonly borrow                               |
| Call non-`~self` method                  | borrowable                                                                 | readonly borrow                               |
| Bind to immutable local (`let x = ray`)  | borrowable unless `x` later requires ownership                             | borrow initially, copy only if later demanded |
| Bind to mutable local (`let ~x = ray`)   | ownership-demanding                                                        | allocate local storage + copy once            |
| Pass to `~param`                         | ownership-demanding unless existing addressable owned storage is available | allocate/copy or reuse owned storage          |
| Call `~self` method on param             | ownership-demanding unless existing addressable owned storage is available | allocate/copy or reuse owned storage          |
| Return as wide value                     | ownership-demanding in callee body, satisfied by caller out destination    | write into out storage                        |
| Capture in closure/effect env            | ownership-demanding                                                        | allocate owned capture payload                |
| Store into object/container/global field | ownership-demanding                                                        | materialize owned stored value                |

## Lowering Algorithm

This is the concrete algorithm the first implementation should follow.

### At function entry

For each parameter:

- if parameter type is small:
  - lower using existing direct ABI
- if parameter type is wide and parameter is non-`~`:
  - bind parameter symbol to readonly borrowed storage
- if parameter type is wide and parameter is `~`:
  - bind parameter symbol to mutable borrowed storage

### During expression lowering

For each use of a wide value binding:

1. classify the use as borrowable or ownership-demanding
2. if the binding currently has owned storage, use that storage
3. else if the use is borrowable, use borrowed storage
4. else:
  - create owned storage
  - copy from borrowed storage into owned storage
  - rewrite this and later ownership-requiring uses to owned storage

### During return lowering

- if return type is small:
  - use existing direct return path
- if return type is wide:
  - ensure caller provided out destination
  - write result fields into out destination
  - avoid intermediate boxing for internal ABI purposes

## Local Binding Semantics

This section clarifies cases that are easy to misread.

### `let x = wide_param`

This does **not** necessarily require an immediate copy.

The compiler may initially treat `x` as another readonly borrowed view of the same
underlying storage, because:

- both source bindings are immutable
- readonly aliasing is not observable through the language

If a later use of `x` or the original parameter becomes ownership-demanding, the compiler
must materialize owned storage at that point for the path that requires it.

### `let ~x = wide_param`

This always requires owned mutable storage for `x`.

The compiler must allocate local storage for `x` and copy the incoming value exactly once.

### `var x = wide_param`

If `var` implies later assignment/rebinding of the full value, `x` needs owned local
storage at the first write or at declaration if the compiler cannot defer safely.

The implementation should prefer the same copy-on-first-owned-use rule rather than eager
copying at declaration whenever practical.

## Container Access Rules

Container access is the second major performance issue for wide values.

### Current problem

For wide value elements, code like:

```voyd
let sphere = world.at(i)
sphere.radius
```

often materializes a full copied `Sphere` value. In hot loops that is too expensive.

### Proposed rule

For addressable containers, reads of wide value elements should lower as temporary
readonly borrows to element storage when the use does not require ownership.

Conceptually:

```voyd
world.at(i).radius
```

should lower like:

```text
borrow element storage at i
read radius from borrowed storage
```

not:

```text
copy full Sphere out of container
read radius from copied Sphere
```

### Borrowed element access is implicit

No new syntax is required. The compiler can do this automatically when:

- the container is addressable
- the element is wide
- the use is read-only
- the use does not escape beyond the statement/expression region

### When a real copy is still required

If the source code requires an owned value, the compiler must materialize one.

Examples:

- returning `world.at(i)` as a value
- storing `world.at(i)` into a mutable local that will later be mutated independently
- capturing the value into a closure/environment as an owned value

## Storage Strategy For Containers

This proposal does not require a full stdlib redesign, but it does require a clear
backend/storage direction.

### Recommended strategy

- small value elements: continue to store inline
- wide value elements: support addressable element storage and borrowed reads

This can be implemented in one of two ways:

1. Inline wide storage with addressable element slots
- preserves packed layout
- requires robust address computation and borrowed field access

2. Indirect wide storage
- container stores references/pointers to per-element storage records
- simplifies borrowed reads
- may add allocation pressure

Preferred direction:

- keep inline storage when possible
- support borrowed addressable access to inline element storage

That aligns best with the overall motivation for value types.

## Interaction With Existing Surface Features

### Methods

- non-`~self` on wide receivers: borrow receiver by default
- `~self` on wide receivers: require addressable mutable storage

### Generics

Generic functions should follow instantiated width classification:

- `T` instantiated with small value: direct ABI
- `T` instantiated with wide value: borrow/out ABI
- `T` instantiated with heap/reference type: existing object/reference ABI

### Trait dispatch

Trait-dispatch wrappers must preserve the same instantiated classification. A wrapper is
not allowed to force a wide value back through box-heavy legacy lowering merely because
dispatch is indirect.

## Mutation Model For Wide Values

### Addressable root rule

Mutating a wide value still requires an addressable root.

Examples of addressable roots:

- `let ~x = ...`
- `~param`
- `~self`
- writable object field storage
- writable out-destination storage

Non-addressable temporaries must still be rejected for mutation.

### Rooted field writes

For wide values, writes should lower against a root storage pointer rather than requiring
full value reconstruction after every field update.

Example:

```voyd
rec.t = root
rec.p = ray.at(root)
```

should lower as field stores into the same addressable record.

## Trait Dispatch

Wide values must work across trait-dispatch paths without reintroducing aggregate boxing
on every call.

### Static dispatch

For generic/static dispatch, use the same internal ABI rules:

- readonly refs for wide by-value params
- mutable refs for `~` params
- out-storage for wide returns

### Dynamic trait dispatch

For dynamic trait dispatch, wrapper signatures must follow the same split:

- small values may remain direct
- wide values should use internal refs/out-storage in wrappers

If dynamic dispatch still requires existential heap carriers in some cases, keep that
allocation visible as a boundary cost, not the default internal cost of every wide-value
call.

## Exports, Imports, And ABI Boundaries

This proposal is specifically about internal optimized ABI.

At boundaries such as:

- host exports
- host imports
- serialized ABI
- public non-optimized module boundaries if needed initially

the compiler may continue to use the existing legal/export ABI.

The important rule is:

- internal optimized ABI may differ from boundary ABI
- boundary lowering/legalization happens after internal calling-convention selection

That lets the compiler get the fast path internally without forcing immediate redesign of
every public interface.

## Optimizer Responsibilities

The optimizer/codegen pipeline needs explicit support for this model.

### Required capabilities

1. Wide-value ABI classification
- decide small vs wide
- pick inline vs ref/out ABI

2. Borrowed-use analysis
- determine when a wide value use can be satisfied by readonly borrow
- determine when an owned copy must be materialized

3. Addressable storage planning
- create local storage records for wide mutable locals and out destinations

4. Copy-on-first-owned-use
- delay wide-value copy until the program actually needs ownership

5. Container access lowering
- borrow wide element storage for read-only access

6. Boundary legalization
- preserve fast internal ABI
- translate only at import/export/serialized boundaries

### Nice-to-have follow-up optimizations

- scalar replacement of small values inside wide storage
- copy elision through chained call/out-destination pipelines
- better inlining for small-value math methods
- dead-store elimination across field initialization of out destinations

## Lowering Examples

### Example 1: readonly param

Source:

```voyd
fn energy(ray: Ray) -> f64
  ray.direction.len_squared()
```

Lowered:

- caller passes readonly `ray_ref`
- callee reads `direction` fields through `ray_ref`
- no full `Ray` copy created

### Example 2: mutable local copy

Source:

```voyd
fn normalize(ray: Ray) -> Ray
  let ~local = ray
  local.direction = local.direction.unit_vector()
  local
```

Lowered:

- incoming `ray` is readonly ref
- `let ~local = ray` allocates local storage and copies once
- mutation writes to local storage
- return writes local storage into caller out-destination

### Example 3: container read

Source:

```voyd
fn sum_radius(world: Array<Sphere>) -> f64
  var total = 0.0
  var i = 0
  while i < world.len():
    total = total + world.at(i).radius
    i = i + 1
  total
```

Lowered:

- `world` may be readonly ref to container storage
- `world.at(i).radius` borrows element storage at `i`
- reads `radius` field directly
- no per-iteration `Sphere` copy

## Source Semantics Checklist

The implementation must preserve all of these:

- `let b = a` still creates an independent value semantically
- non-`~` params are still semantically by-value
- `~` params still require addressable caller storage
- returning a value still returns a fresh result value semantically
- no user-observable aliasing is introduced

If any lowering would violate those properties, the compiler must materialize a copy.

## Rollout Plan

### Phase 1: internal ABI split

Implement:

- small vs wide classification
- readonly-ref lowering for wide non-`~` params
- mutable-ref lowering for wide `~` params
- out-destination lowering for wide returns

Do this for direct internal calls first.

### Phase 2: trait-dispatch alignment

Extend the same ABI rules through:

- trait dispatch wrappers
- method-call lowering
- generic instantiations that use dynamic wrappers

### Phase 3: borrowed container element reads

Implement:

- borrowed lowering for read-only element access of wide values
- fix `Array<WideValue>` hot-loop behavior

### Phase 4: ownership-sensitive copies

Implement:

- copy-on-first-owned-use
- better lowering for `let x = wide_param`
- better lowering for mutation after param binding

## Concrete Implementation Plan

This section maps the proposal onto the current compiler structure.

### 1. Classification

Add a canonical helper for "small vs wide value" classification and make it usable from:

- semantics/codegen-view call metadata
- codegen call lowering
- container access lowering

Likely touch points:

- [packages/compiler/src/codegen/types.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/types.ts)
- [packages/compiler/src/codegen/context.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/context.ts)

### 2. Function metadata ABI expansion

Extend function metadata to carry both:

- source type ids
- optimized internal ABI kinds per parameter/result

Suggested ABI kinds:

- `direct`
- `readonly_ref`
- `mutable_ref`
- `out_ref`

Likely touch points:

- [packages/compiler/src/codegen/context.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/context.ts)
- [packages/compiler/src/codegen/functions.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/functions.ts)

### 3. Call lowering

Teach direct call lowering and method call lowering to:

- pass wide non-`~` args as readonly refs
- pass wide `~` args as mutable refs
- allocate and pass out destinations for wide returns

Likely touch points:

- [packages/compiler/src/codegen/expressions/call/arguments.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/call/arguments.ts)
- [packages/compiler/src/codegen/expressions/call/resolved-call.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/call/resolved-call.ts)
- [packages/compiler/src/codegen/expressions/call/entrypoints.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/call/entrypoints.ts)
- [packages/compiler/src/codegen/expressions/call/trait-dispatch.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/call/trait-dispatch.ts)

### 4. Local storage materialization

Add a representation for wide bindings that can begin life as borrowed and later upgrade
to owned storage on first ownership-demanding use.

Likely touch points:

- [packages/compiler/src/codegen/locals.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/locals.ts)
- [packages/compiler/src/codegen/expressions/mutations.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/mutations.ts)
- [packages/compiler/src/codegen/patterns.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/patterns.ts)

### 5. Container borrowed access

Teach wide element reads to borrow addressable storage instead of materializing full value
copies when the use is read-only.

Likely touch points:

- [packages/compiler/src/codegen/structural.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/structural.ts)
- [packages/compiler/src/codegen/expressions/objects.ts](/Users/drew/projects/voyd/packages/compiler/src/codegen/expressions/objects.ts)
- relevant std array lowering/codegen paths

### 6. Tests

Required tests should cover:

- wide non-`~` param read-only use does not force eager copy
- wide `~param` uses mutable ref path
- wide return uses out destination path
- trait dispatch preserves wide return correctness
- `Array<WideValue>` read-only field access avoids incorrect behavior and repeated copies
- source semantics remain correct when immutable aliases exist and one path later requires
  owned mutable storage

Recommended layers:

- compiler codegen tests for ABI shape and wasm validity
- smoke tests for runtime correctness on wide param/return/container cases

## Acceptance Criteria

This proposal should be considered implemented only when all of the following are true:

1. Wide non-`~` params are no longer eagerly copied at function entry in optimized
   internal ABI.
2. Wide returns no longer require internal aggregate spill boxing as the steady-state
   return path.
3. Trait-dispatch wrappers preserve the same wide-value ABI strategy.
4. Read-only hot-loop access to `Array<WideValue>` no longer requires full element
   materialization.
5. Source-level value semantics remain unchanged in all tested cases.

## Success Criteria

This proposal is successful if:

- wide values no longer regress badly against heap objects in hot code
- mixed strategies like `Vec3` as value plus `Ray`/`Sphere`/`HitRecord` as values become
  competitive with heap versions
- container iteration over wide values no longer forces repeated full copies
- no new syntax is required to obtain the performance benefits

## Explicit Answer: Should Non-mutable Params Be References?

Yes, for wide values, internally they generally should.

More precisely:

- semantically: non-`~` params remain by-value
- physically: the compiler should usually lower wide non-`~` params as readonly refs
- copying should be deferred until the callee actually needs owned mutable storage or an
  escaping owned value

So the right model is not "always copy values into params".
The right model is:

- small values: copy/direct ABI is fine
- wide values: borrow by default, copy only when semantics demand ownership

That is the core change needed to make wide value types viable for performance-sensitive
code without changing the language surface.
