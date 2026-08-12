# Scoped Explicit Borrows

Status: Proposed

Decision date: 2026-08-09

## Summary

Voyd will keep explicit borrows, but a borrow will only be valid inside a
bounded call or callback.

Voyd will remove borrowed results, borrow-carrying containers, named regions,
borrow contracts, and `ViewIterator`.

Voyd will also replace path-sensitive borrowing contracts for ordinary `~T`
code with bounded whole-parameter mutation summaries. Detailed provenance will
run only for callables whose signatures explicitly contain `Borrow<T>`.
Release optimizations may request bounded exact-call facts, while fast paths
that lose their proof must be removed.

This keeps the current mutation-safety level. It removes safe but unused forms
of zero-copy programming and prevents ordinary generic object graphs from
creating unbounded borrow-provenance state.

## Context

Voyd currently supports `borrow T` as a value that can move through results,
generic containers, pattern matching, closures, and separate compilation. A
public trait can use named regions and `@borrow_contract` to describe where a
borrowed result came from.

The current spelling is also a parser special case. The parser treats `borrow`
as a contextual prefix operator and has extra handling for generic inner types.
The new scoped model does not need this unusual syntax.

The standard library uses this full model only for `ViewIterator`. No product
code in this repository uses a borrowed result. Ordinary `Iterator<T>` already
returns values and has compiler optimizations for wide values.

`SharedCell<T>` has a real use for `Borrow<T>`. Its callbacks lend access to the
stored value for a short scope:

```voyd
cell.with((value) =>
  inspect(value)
)

cell.with_mut((~value) =>
  value.count = value.count + 1
)
```

The callback must not keep `value` after it returns.

The current general model adds substantial compiler work. The compiler must
track borrowed results through control flow, calls, wrappers, generic code,
closures, module boundaries, and dynamic dispatch. Ordinary runtime code is
already cheap, so the main expected gain from this decision is faster and
simpler compilation.

The V-499 provider investigation showed that borrowed-result removal alone is
not enough. A selected-provider compile changed from 1,093 to 1,701 borrowing
summary functions while borrowing analysis grew from about 576 ms to 1,274 ms
on an independent reproduction. Contract inference grew from about 207 ms to
658 ms, and projection-family widenings grew from 153 to 2,274. The implicated
`std::data`, `std::msgpack`, and `std::msgpack::fns` modules used no explicit
`borrow` values. Their generic traits and 199 `~` uses stressed the ordinary
mutation-analysis path.

These measurements prove superlinear growth for that provider topology. They
do not establish an exponential complexity class. They do establish that a
scalable design must prevent ordinary `~T`, generic, trait, and object code from
entering the general provenance fixed point.

## Decision

### Keep four memory-safety concepts

Voyd will keep this small source model:

1. `T` is an ordinary value or GC-managed object handle.
2. `~T` grants exclusive access for a bounded call or callback.
3. `Borrow<T>` grants shared access for a bounded call or callback.
4. `SharedCell<T>` provides explicit runtime-checked shared mutation.

Garbage collection continues to manage allocation lifetime. Borrow checking
continues to prevent overlapping access that includes mutation.

### Preserve ordinary mutation isolation

`~T` remains a safety capability. While `~value` is active, the covered place
or object allocation cannot be read or mutated through another alias. This
includes reentrant access through another argument, a callback, a closure,
module state, dynamic dispatch, or an effect handler.

```voyd
fn increment(~state: State, notify: () : () -> void) -> void
  state.count = state.count + 1
  notify()
  state.count = state.count + 1
```

The call is rejected when `notify` is unknown because it could access an alias
of `state` while the exclusive capability is active. A statically resolved call
is allowed when its bounded mutation summary proves that it cannot overlap.

Potentially overlapping call arguments must be proven disjoint, checked with a
bounded runtime identity guard, or rejected. `~T` does not imply whole-program
uniqueness. An optimizer may use no-alias facts only for the bounded access that
the safety analysis proves.

Ordinary `~T` duration remains local and non-lexical. It begins when exclusive
access is activated and may end after the final local use. This requires only
local control-flow analysis. A nested callable receives a bounded reborrow for
its invocation; the compiler does not infer that duration through the call
graph.

For an object, `~obj` covers the handle place and referenced allocation. For a
`val`, `~value` is bounded inout access with logical copy-in and copy-out
behavior. The compiler may operate through a physical reference, but it must
materialize and write back the logical value whenever uncertainty makes that
necessary.

### Separate ordinary mutation analysis from explicit borrow analysis

The compiler will use two separate analyses:

1. Ordinary mutation analysis enforces `~T` isolation with finite
   whole-parameter summaries.
2. Explicit borrow analysis enforces the scope and non-escape rules of
   `Borrow<T>` and `~Borrow<T>`.

They may share local place and overlap utilities. They must not share a general
interprocedural provenance solver. A callable without `Borrow<T>` in its
normalized signature must never create explicit-borrow provenance facts.

### Bound ordinary callable summaries

An ordinary callable summary contains only:

- one access mode per parameter: `unused`, `read`, or `write`;
- whether the callable accesses ambient object state;
- whether it invokes an unknown callback; and
- whether it may suspend.

The summary has no field, tuple, index, dereference, region, result, or generic
projection paths. Its number of states must not depend on object field count,
projection depth, generic nesting, returned aggregate shape, call-path count,
or trait implementation count.

Local analysis may distinguish fields and stable indices inside one callable.
At an ordinary call or package boundary, access collapses to the whole
parameter or allocation. A function such as this publishes only that it writes
parameter zero:

```voyd
fn update(~state: State) -> void
  state.profile.count = state.profile.count + 1
```

Ordinary signatures provide access upper bounds: plain `T` permits at most
`read`, and `~T` permits at most `write`. A concrete body may refine an unused
parameter to `unused`. Every trait implementation is checked against the
declared upper bound, and a dynamic caller uses that bound. Dynamic dispatch
must not join field-sensitive implementation contracts.

Every callable with a `~T` parameter must prove that it does not perform
potentially aliasing ambient object access, invoke an unknown callback, or
suspend. This is a signature-level implementation obligation for ordinary
functions, trait methods, and every trait implementation. It makes dynamic
`~T` dispatch safe without joining implementation-specific provenance. A
statically resolved helper may access state only when local analysis proves it
disjoint from every active exclusive capability.

While an exclusive capability is active:

- a known call is allowed when its bounded summary is compatible;
- an unknown callback, suspension, or effect operation is rejected;
- ambient object access is rejected unless local analysis proves it disjoint;
  and
- a reference-bearing call result is conservatively treated as possibly
  aliasing every reference-bearing argument for the rest of the active scope.

The last rule is local to the caller. It is not a returned-origin contract
published by the callee.

### Prevent exclusive-capability laundering

An active `~T` capability cannot be stored, captured, suspended, passed to an
unknown callable as plain `T`, or otherwise hidden from mutation analysis. An
exclusive reborrow suspends its parent until the nested call returns.

An exclusive capability itself cannot be returned. A callable may return an
ordinary object handle derived from an argument because its exclusive access
has ended when the call returns. The caller applies the conservative local
result-alias rule above, so it cannot use that handle while an overlapping
parent capability remains active. No callee-specific returned-origin summary is
needed.

### Spell scoped borrows as `Borrow<T>`

Voyd will replace the prefix spelling `borrow T` with the built-in type
constructor `Borrow<T>`. This follows the syntax and naming used by other Voyd
types:

```voyd
fn inspect<T>(value: Borrow<T>) -> i32
```

`Borrow<T>` looks like a generic type, but it is not an ordinary library type.
The compiler defines its scope, escape, alias, and runtime-representation rules.
Programs cannot construct it as an ordinary value.

`Borrow` is an unshadowable compiler-known type name with exactly one type
argument. A package cannot declare another type named `Borrow`.

The parser must remove all special-case handling for `borrow T`. This includes
removing `borrow` as a contextual prefix operator and removing its custom
generic-inner-type parsing. `Borrow<T>` must use the same generic type syntax as
other type constructors. Backwards compatibility for `borrow T` is not
required.

The compiler checks legal occurrences after expanding type aliases. The only
legal type occurrence is `Borrow<T>` as the complete type of a callable input
parameter. This includes an input inside a nested function type:

```voyd
fn run<T, R>(value: T, body: fn(value: Borrow<T>) : () -> R) -> R
```

The function value does not contain an active borrow. It may be stored, passed,
returned, or named by a type alias. A borrow becomes active only when that
callable is invoked.

An active local alias may also have type `Borrow<T>` when it is initialized from
an active borrowed parameter or projection. Every other normalized occurrence
is rejected. In particular, an active borrow cannot be a result, object or
aggregate field, tuple or union member, module value, or ordinary generic
argument. A stored function type whose input is `Borrow<T>` remains legal
because the stored value is a callable, not an active borrow.
`Borrow<Borrow<T>>` is always rejected.

### Limit `Borrow<T>` to scoped parameters

`Borrow<T>` may appear in a function or method parameter:

```voyd
fn inspect<T>(value: Borrow<T>) -> i32
  // Read value without taking ownership.
```

It may also appear in a callback parameter:

```voyd
fn with_value<T, R>(
  value: T,
  { body: fn(value: Borrow<T>) : () -> R }
): () -> R
  body(value)
```

A local binding may refer to the same borrow while that parameter scope is
active. The local binding does not extend the scope.

A borrowed parameter may be passed to another `Borrow<T>` parameter. This
supports small helper functions:

```voyd
fn checksum(bytes: Borrow<Bytes>) -> i32
  // ...

cell.with((bytes) =>
  checksum(bytes)
)
```

### Form and activate scoped borrows

A plain `T` argument implicitly forms shared access when the selected parameter
type is exactly `Borrow<T>`. `Borrow` is invariant: the inner type must match
after normal alias expansion and type inference. Borrow formation does not
perform subtype, trait-object, or other representation-changing widening. The
argument may be an existing place or a temporary. A temporary remains alive
until the call returns.

The loan covers the argument place and every source-derived alias reached from
that place. For an object handle, this includes the referenced allocation. A
projection may narrow the covered place, but it does not erase the loan's
origin. The compiler represents this across calls as one borrowed-parameter
origin. It must not enumerate the reachable object graph or publish a distinct
origin for each projection.

Calls use the existing safe evaluation order:

1. evaluate the receiver and explicit arguments in source order;
2. evaluate omitted defaults in parameter order;
3. perform static checks and required runtime identity guards;
4. activate parameter access;
5. run the callable;
6. end parameter access when the callable returns.

A `Borrow<T>` parameter remains active for the full invocation. Local aliases
and projections end no later than that invocation. This full-invocation rule is
intentional: scoped borrowing does not require last-use lifetime inference.

Passing `Borrow<T>` to another `Borrow<T>` parameter creates a nested shared
reborrow. Nested shared reborrows are allowed. Passing a borrowed value to a
plain `T` parameter is rejected, including concrete parameters, callback
parameters, overloads, defaults, imports, and callable adaptation. A callable
with a plain `T` input cannot satisfy a callable type with a `Borrow<T>` input,
and the reverse adaptation is also rejected.

### Form exclusive scoped borrows

`~value: Borrow<T>` means exclusive scoped access to the borrowed place. It is
the replacement for `~value: borrow T`.

Exclusive scoped access may be formed only from:

- an existing exclusive `~T` place;
- an existing `~Borrow<T>` capability through an exclusive reborrow; or
- a successful compiler-known `SharedCell<T>` exclusive guard.

A shared `Borrow<T>` can never be upgraded to `~Borrow<T>`. An exclusive
capability may create a shared `Borrow<T>` reborrow. While either shared or
exclusive reborrow is active, the parent exclusive capability is suspended.
It becomes usable again after the nested call returns.

An exclusive scoped parameter may rebind or mutate its value according to the
normal `~T` rules. For a `val`, updates are written back to the borrowed place.
For an object, field mutation affects the borrowed allocation and rebinding
updates the borrowed handle slot.

### Keep the `SharedCell<T>` callback contract

`SharedCell<T>` will use these public signatures:

```voyd
impl<T> SharedCell<T>
  api fn with<R>(
    self,
    body: fn(value: Borrow<T>) : () -> R
  ): () -> R

  api fn with_mut<R>(
    self,
    body: fn(~value: Borrow<T>) : () -> R
  ): () -> R

  api fn try_with<R>(
    self,
    body: fn(value: Borrow<T>) : () -> R
  ): () -> Result<R, SharedCellBorrowError>

  api fn try_with_mut<R>(
    self,
    body: fn(~value: Borrow<T>) : () -> R
  ): () -> Result<R, SharedCellBorrowError>
```

The runtime guard begins before the callback and ends after it returns. Shared
callbacks may nest. Any overlap involving an exclusive callback fails through
the existing panic or `Result` behavior.

An exclusive callback may rebind the stored value. When it returns, the cell
writes the updated `val` or object handle back to its slot before ending the
guard. The callback result must be independent under the projection rules
below; generic `R` cannot hide an active borrow.

### Remove borrowed results

No function, method, callback, or trait method may return a borrow:

```voyd
fn item_at<T>(items: Array<T>, index: i32) -> Borrow<T>
  // error: borrowed results are not supported
```

A borrow may not appear inside a result container:

```voyd
fn item_at<T>(items: Array<T>, index: i32) -> Option<Borrow<T>>
  // error: borrowed results are not supported
```

This rule is the same for concrete calls and dynamic trait calls.

An API that needs zero-copy access must use a scoped callback:

```voyd
trait CollectionAccess<T>
  fn with_item<R>(
    self,
    index: i32,
    { body: fn(item: Borrow<T>) : () -> R }
  ): () -> Option<R>
```

The callback can return an independent value through a Borrow-aware helper:

```voyd
fn item_length(item: Borrow<Item>) -> i32
  item.length

let length = collection.with_item(0, body: (item) =>
  item_length(item)
)
```

The callback cannot return the item:

```voyd
let item = collection.with_item(0, body: (item) =>
  item
)
// error: the borrow escapes its callback
```

An API may also return an owned value, index, key, cursor, or stable immutable
view such as `StringSlice`.

### Prevent borrow laundering

A borrow must not become a plain `T` and escape.

Direct conversion is rejected:

```voyd
fn leak(value: Borrow<Box>) -> Box
  value
// error: the borrow escapes as a plain value
```

Wrapping the borrow is also rejected:

```voyd
obj Holder {
  value: Box
}

fn leak(value: Borrow<Box>) -> Holder
  Holder { value }
// error: Holder would retain the borrow
```

A borrow may not be stored in an object, structural value, tuple, union,
module binding, `SharedCell`, or other storage that can outlive the scope.

### Preserve scoped origins through projections

Every alias-preserving projection or operation derived from `Borrow<T>` keeps
the scoped parameter origin. Its declared field or element type does not erase
that origin.

```voyd
obj Wrapper {
  inner: Box
}

fn leak(value: Borrow<Wrapper>) -> Box
  value.inner
// error: value.inner is still scoped to value
```

Explicit borrow analysis tracks only the originating borrowed parameter, plus
local projections needed to check overlap inside the current callable. It does
not publish field or index projection families across a call or package
boundary.

The local rule applies to:

- object fields and nested fields;
- array and container elements;
- tuples, structural values, destructuring, and pattern bindings;
- callable fields and closures stored inside borrowed data;
- compiler-known operations; and
- object handles inside a copied `val` or other aggregate.

Local type inference must preserve the scoped origin. Wrapping, copying,
destructuring, generic substitution, overload resolution, and callable
adaptation must not erase it.

A value may leave the scope only through this closed independent-result
classification:

- primitives and scalars are independent copies;
- a reference-free `val`, tuple, or structural value is independent after its
  ordinary logical copy;
- a mutable object, mutable storage handle, closure, or aggregate containing one
  remains derived from the borrowed parameter;
- a newly allocated object is independent only when its type structure proves
  that it contains no derived mutable handle; and
- a compiler-known stable immutable retained handle may be independent.

`StringSlice` is the initial stable immutable retained type. The result must
retain its backing directly, and later mutation of the original owner must not
change that backing. Adding another type to this category requires a separate
language or standard-library contract decision. The compiler must not infer the
category through callable bodies or a provenance fixed point.

A whole `val` containing an object handle is therefore not automatically
independent. The compiler may copy out its scalar fields, but copying a mutable
object handle preserves the scoped origin.

### Keep ordinary generics borrow-free

A borrowed value may not instantiate an ordinary generic parameter:

```voyd
fn identity<T>(value: T) -> T
  value

cell.with((value) =>
  identity(value)
)
// error: Borrow<T> cannot be used as ordinary T
```

Generic helpers that accept scoped access must use a parameter that normalizes
to `Borrow<T>`:

```voyd
fn inspect<T>(value: Borrow<T>) -> i32
  // ...
```

This keeps ordinary generic code free from hidden loan propagation.

### Require explicit Borrow-aware calls

A borrowed value does not implicitly become a plain method receiver. In the
initial model, borrowed code uses direct projections, compiler-known operations,
or helpers whose parameter explicitly normalizes to `Borrow<T>` or
`~Borrow<T>`:

```voyd
fn state_count(value: Borrow<State>) -> i32
  value.count

cell.with((state) => state_count(state))
```

`~Borrow<T>` may call another helper whose parameter is exactly
`~Borrow<T>`. It may also create a shared `Borrow<T>` reborrow. A shared borrow
cannot call an exclusive helper.

Ordinary methods, callable adaptation, and dynamic or open-trait dispatch are
rejected for a borrowed receiver. A trait method may accept an explicit
`Borrow<T>` non-receiver parameter; every implementation is checked against
that parameter type. Borrow-aware receiver syntax may be considered later, but
this decision does not require it.

### Reject closure, effect, and host boundaries

An active borrow may not be captured by any closure, including a closure that
appears to run immediately. Nested code must receive the borrow through an
explicit `Borrow<T>` or `~Borrow<T>` parameter. This keeps closure environments
free of active loans.

An active borrow may not cross an effect operation, suspension, task boundary,
or continuation boundary. Under the full-invocation rule, a callable with a
borrowed parameter cannot perform an effect operation before it returns.
Checked direct effects are a separate future decision.

`Borrow<T>` is rejected in every host or Wasm import, host or Wasm export, FFI
signature, and host call. This restriction does not apply to ordinary Voyd
package imports and exports; public Voyd APIs may use scoped `Borrow<T>` input
parameters. Compiler-known intrinsics may implement `SharedCell` and internal
physical borrowing, but they cannot expose a source borrow to a host. Public
scoped FFI contracts require a separate future decision.

### Use conservative fallback rules

Lost information must never become an assumption of safety.

When access may overlap, the compiler must do one of these:

- prove that the places are disjoint;
- insert a bounded runtime identity guard;
- reject the program.

Every public ordinary summary must conservatively fit the finite summary model.
Every public Borrow-aware boundary preserves only its borrowed-parameter
origins. An optimizer may use more precise local facts, but optimizer facts are
never required for correctness.

### Keep internal physical borrowing

The compiler may still use an internal physical borrow to avoid copying a wide
value. This is an optimization and is not part of the source type.

The compiler must create an ordinary value before escape, storage, suspension,
an unknown call, conflicting mutation, or any other point where the physical
representation would change accepted source behavior.

### Remove the general region system

Voyd will remove:

- trait `region` declarations;
- implementation region mappings;
- `deref(...)` contract-place expressions;
- `disjoint` declarations;
- `@borrow_contract`;
- borrowed return types;
- borrow-carrying generic containers and aggregates;
- `ViewIterator` and `Array.view_iter()`.

Ordinary `Iterator<T>` remains the standard iteration API.

## Safety

This decision does not weaken Voyd's defined memory safety.

The new model has fewer legal loan states. A source-visible borrow cannot live
past the call or callback that created it. The compiler no longer needs to
prove that an escaping borrow stays valid through arbitrary program structure.

The following rules are required for safety:

- plain `T` never hides a source-level borrow;
- `~T` remains exclusive for its active scope, including against reentrant
  access through ordinary aliases;
- ordinary mutation summaries conservatively describe whole-parameter access,
  ambient object access, unknown callbacks, and suspension;
- uncertain ordinary call results are treated locally as possible aliases of
  their reference-bearing arguments;
- an active exclusive capability cannot be stored, captured, returned,
  suspended, or erased as plain `T` at an unknown call;
- `Borrow<T>` cannot escape, be stored, or be erased by generics;
- shared access cannot be upgraded to exclusive access;
- source-derived projections keep their scoped origin unless an independent
  copy is proven;
- borrowed values may call only compiler-known operations or explicitly
  Borrow-aware helpers;
- active borrows cannot be captured or cross effect, suspension, task, or
  continuation boundaries;
- uncertain overlap is guarded or rejected;
- internal physical borrows materialize before ownership becomes observable;
- host and Wasm imports, host and Wasm exports, FFI, and host boundaries cannot
  receive a source borrow.

The existing out-of-scope areas remain out of scope: raw linear memory, unsafe
facilities, FFI implementation safety, and future multi-threaded transfer and
synchronization.

## Developer Experience

Most current application code in this repository is expected to keep working.
Applications use ordinary values, `~`, and `SharedCell` callbacks rather than
borrowed results. Code that invokes unknown callbacks during exclusive mutation
must be restructured.

Some safe callback-heavy mutation APIs may require restructuring. An unknown
callback cannot run while `~T` is active because it could reenter through an
ordinary alias:

```voyd
fn update(~state: State, log: fn(String) : () -> void) -> void
  state.count = state.count + 1
  log("updated") // rejected while log has unknown captured access
```

The initial alternatives are to finish exclusive mutation before invoking the
callback, pass an independent value to a statically resolved helper, or use an
explicit runtime-checked abstraction such as `SharedCell`. A future callable
effect or capture contract may accept more cases without restoring general
provenance inference.

Scoped callbacks are less convenient when several borrowed values must be used
together:

```voyd
left.with_item(0, body: (left_item) =>
  right.with_item(0, body: (right_item) =>
    compare(left_item, right_item)
  )
)
```

This nesting is the main developer-experience cost. Voyd should reconsider
borrowed results only after a real application shows that owned values, stable
handles, immutable views, and scoped callbacks are materially inadequate.

## Performance

### Compiler performance

This decision requires an architectural reduction, not only less source syntax.
The compiler must remove:

- returned-loan provenance;
- borrow propagation through result containers and generic wrappers;
- borrowed-result SCC inference;
- named-region binding, mapping, and validation;
- borrowed-result information in package and cache summaries;
- compact-contract composition for ordinary callables;
- interprocedural projection-family propagation and widening for ordinary
  mutation analysis; and
- detailed borrow facts for every callable whose normalized signature contains
  no `Borrow<T>`.

Ordinary mutation summaries must use a finite representation such as numeric
access modes and bit flags. Their equality must not depend on serializing
structural contracts. The solver must operate with a dependency worklist, visit
only callers whose dependency summary changed, and converge per strongly
connected component. Its documented bound must depend on callable edges and the
fixed summary lattice, not on projection-family cardinality.

Explicit borrow provenance must be parameter-level across calls. Local
field-sensitive facts must be discarded at the callable boundary. Programs
without `Borrow<T>` must create zero explicit-borrow provenance facts.

### Separate safety facts from optimization facts

The bounded safety summary is not the only information an optimizer may use.
A release optimization may request a more precise fact for one exact callable
when a concrete transformation needs it. This fact is separate from program
acceptance and may describe:

- direct fields read and written;
- whether a parameter or derived alias escapes or is retained;
- whether the result may alias a parameter;
- external object access;
- suspension;
- nested, recursive, dynamic, or unresolved calls; and
- identity guards or unsupported aliases.

An exact-call optimization fact must be:

- computed only for an actual optimization candidate;
- limited to an exact callable body or a separately cached exact-body fact;
- budgeted, cached, and safe to abandon;
- conservative at recursive, nested, dynamic, and unresolved call boundaries;
- excluded from safety summaries and safety fixed points; and
- irrelevant to whether the source program is accepted.

The ordinary ABI or materialized representation is always the fallback. An
optimizer must not request general provenance inference merely to search for
candidates.

This path preserves current profitable optimizations when their existing exact
conditions hold. In particular:

- stable fixed-field load forwarding may use an exact-call field effect;
- fresh mutable aggregate promotion may use exact field, escape, retention,
  result-alias, external-access, and suspension facts;
- wide values may remain physically borrowed until an ownership-demanding or
  opaque boundary; and
- exact iterator and scalar-replacement optimizations may keep using bounded
  escape, reachability, and call-target facts.

### Remove optimization paths that lose their proof

Every optimization that currently consumes borrowing contracts must be
inventoried during implementation. Each consumer must move to one of these
owners:

1. the finite ordinary safety summary;
2. explicit `Borrow<T>` checking;
3. the bounded exact-call optimization fact; or
4. deletion.

There must be no compatibility adapter that interprets a coarse summary as a
legacy precise contract. An optimization must be removed or conservatively
disabled when it:

- depends on borrowed results, named regions, `disjoint`, or
  `@borrow_contract`;
- assumes that a whole-parameter write is disjoint from a field or index;
- treats `~T` as unique beyond its proven active scope;
- retains an internal physical borrow across storage, escape, suspension, an
  opaque call, or conflicting mutation;
- combines dynamic trait implementation details into a precise field
  footprint;
- elides an identity guard without an independent local proof; or
- depends on returned or retained provenance that neither explicit Borrow
  analysis nor an exact-call optimization fact proves.

Removing an unsound fast path is required even when it causes a runtime
regression. A replacement optimization may be added only with a bounded proof
and a focused behavior, emitted-shape, and performance test.

### Performance acceptance criteria

Performance analysis is a required implementation deliverable. It must compare
the base revision with the completed implementation on the same machine and
include these workload families:

1. a provider-neutral generic DTO graph with nested records, variants, traits,
   projected mutation, and no explicit `Borrow<T>`;
2. the same graph at several independently generated sizes, including at least
   four growth points;
3. explicit-Borrow graphs that independently increase Borrow-aware calls,
   projection depth, and nested scoped callbacks;
4. mutation graphs that vary direct calls, dynamic calls, callbacks, ambient
   state, identity guards, and SCC shape;
5. a full `pkg::web` cold compile and a representative full-stack application;
6. a warm source-only edit through one SDK instance;
7. the historical V-499 selected-provider and host-boundary-disabled compiles
   as regression controls; and
8. the accepted checked-access optimization suite, including stable-field
   forwarding, mutable aggregate promotion, counted-array and Range fast paths,
   intrinsic Array iteration, and exact iterator specialization.

The implementation must not special-case the V-499 fixture, module names,
provider, or topology. The generated scaling families and full-stack workloads
are authoritative when a historical fixture and the general result differ.

Required measurements are:

- total semantic and compilation time;
- ordinary mutation-analysis time;
- explicit borrow-analysis time;
- callable and call-edge count;
- ordinary summary evaluations and SCC reevaluations;
- explicit borrow fact count;
- projection-family and widening count;
- retained summary bytes and peak resident memory;
- optimized runtime and emitted Wasm size for affected fast paths; and
- optimization acceptance and fallback counts by reason.

The implementation must satisfy these structural gates:

- increasing ordinary DTO field count does not increase interprocedural
  mutation-summary size;
- ordinary mutation analysis creates no projection families or widenings;
- a program with no `Borrow<T>` creates zero explicit-borrow provenance facts;
- ordinary summary evaluations remain close to growth in affected call edges;
- doubling repeated DTO topology does not produce superlinear summary-state
  growth;
- the selected-provider graph no longer routes ordinary `~T` functions through
  detailed borrow analysis;
- exact-call optimization analysis stays within its configured work and memory
  budgets; and
- removing the legacy contracts does not silently disable an accepted
  optimization without a recorded disposition and benchmark result.

The report must include the compiler revisions, hardware, commands, sample
counts, warmup policy, distributions or ranges, raw counters, and same-machine
ratios. Scaling conclusions must use the generated size series, not two
endpoints. Counter and state-growth gates are authoritative across machines.
Regressions must not be hidden with higher timeouts, fewer workers, test-only
source batching, or benchmark-specific compiler branches.

The source-import dependency-snapshot miss described by the same investigation
is separate. This decision does not remove the import surface from the cache
key. Dependency typing snapshots must become source-independent before that
cache boundary can change.

### Runtime performance

Ordinary Voyd code already has no persistent runtime loan table. This decision
adds no persistent runtime bookkeeping to ordinary code. Runtime performance
may regress where a legacy fast path has lost its proof and no bounded
replacement is justified. The implementation report must identify each such
case rather than hiding it.

Bounded identity guards remain available for dynamic uncertainty. Internal
physical borrowing and iterator specialization remain available for runtime
performance.

## Consequences

### Benefits

- The safety model has fewer states and a smaller proof surface.
- Plain values and ordinary generic code have simpler meaning.
- `SharedCell` keeps its useful scoped API.
- The compiler no longer supports unused borrowed-result machinery.
- Ordinary mutation summaries have fixed size per callable parameter.
- Ordinary generic and trait graphs do not participate in explicit borrow
  provenance.
- Public semantic and cache summaries become smaller and structurally bounded.
- The optimizer can keep bounded exact-call facts without making them part of
  the safety contract or global provenance solve.

### Costs

- Linear borrowed-result APIs are unavailable.
- Zero-copy access sometimes requires callback nesting.
- Borrowed values use explicit Borrow-aware helpers instead of ordinary method
  dispatch.
- Unknown callbacks and ambient object access are rejected during ordinary
  exclusive mutation.
- Active borrows cannot be captured or used by effectful code.
- Dynamic trait dispatch on a borrowed receiver is unavailable.
- Host, Wasm, and FFI boundaries cannot accept source borrows.
- Some safe programs become invalid until a real use case justifies a new
  design.
- Some legacy optimization cases may fall back when their old proof cannot be
  replaced safely within the optimizer budget.
- Compiler performance improvements are expected but must be measured.

## Alternatives Considered

### Keep the current general borrow model

Rejected because its complexity is much larger than its demonstrated use. It
also makes ordinary generic and cross-module analysis borrow-aware.

### Keep path-sensitive ordinary mutation contracts

Rejected because V-499 showed superlinear behavior in ordinary generic `~T`
code with no explicit source borrows. Field and result precision across callable
boundaries is not required to preserve whole-object mutation isolation.

### Drop mutation isolation for ordinary objects

Rejected because alias-based reentrant observation and mutation would break
Voyd's local-reasoning guarantee. `~obj` remains a real exclusive capability,
even though the analysis becomes coarser.

### Keep concrete borrowed results

Rejected for now because the repository has no production use for them.
Keeping them would preserve much of the result-provenance system that this
decision aims to remove.

### Remove explicit borrows completely

Rejected because `SharedCell` needs a clear, general way to lend non-escaping
access. Removing the marker would require another scoped-access feature or a
compiler special case.

### Replace static checking with a runtime loan table

Rejected because it would add runtime state, cleanup, and failure paths to
ordinary access. Voyd's current bounded guards and `SharedCell` cover the cases
where runtime checks are useful.

### Make mutation an algebraic effect

Rejected because effect rows describe computation and control. Borrow checking
describes storage identity and overlapping access. Making all mutation an
effect would change Voyd's normal object model without solving the main
compiler cost directly.

## Migration

Implementation should proceed in this order:

1. Record the base-revision compiler, memory, runtime, and Wasm-size results for
   every workload family in the performance plan.
2. Inventory every compiler and codegen consumer of current borrowing
   contracts. Record whether each consumer will use the finite safety summary,
   explicit Borrow facts, a bounded exact-call optimization fact, or deletion.
3. Introduce the finite ordinary mutation summary and dependency worklist.
4. Route ordinary `~T` safety through that summary while preserving exclusive
   isolation, local place precision, bounded identity guards, and conservative
   callback, ambient-access, result-alias, and suspension rules.
5. Add the unshadowable built-in `Borrow<T>` type, replace `borrow T`, and
   remove the parser's contextual prefix and custom generic-inner-type handling.
6. Enforce normalized type-position, exact callable, formation, activation,
   reborrow, exclusive-access, and explicit Borrow-aware call rules.
7. Migrate all four `SharedCell<T>` methods to `Borrow<T>` and
   `~Borrow<T>`.
8. Preserve only parameter-level scoped origins across Borrow-aware calls. Keep
   field and index projections local. Apply the closed independent-result
   classification.
9. Reject borrowed results, active borrows inside stored values and ordinary
   generic arguments, ordinary borrowed-receiver dispatch, closure capture,
   effects, every host or Wasm import and export, every FFI signature, and every
   host call.
10. Add the bounded exact-call optimization fact, migrate justified consumers,
    and remove every optimization whose old proof is no longer valid.
11. Remove `ViewIterator`, `Array.view_iter()`, named regions,
    `@borrow_contract`, and their exports and syntax.
12. Delete borrowed-result SCC inference, ordinary compact-contract
    composition, interprocedural ordinary projection families and widenings,
    general returned-origin contracts, and borrow transfers through containers.
13. Remove obsolete borrow fields from module interfaces, dependency snapshots,
    caches, and codegen views.
14. Update the memory-safety specification, language reference, conformance
    manifest, and test inventory, then run the correctness and performance
    gates.
15. Publish the optimization-consumer disposition and complete performance
    analysis with the implementation.

## Validation

Validation must cover observable behavior at the smallest useful boundaries.

Required cases include:

- ordinary `~obj` mutation isolation against aliases passed as other arguments;
- rejection of reentrant alias access through unknown callbacks, module state,
  closures, effects, suspension, and dynamic calls with uncertain access;
- acceptance of statically resolved helpers whose bounded summaries are
  compatible with an active exclusive capability;
- local field and stable-index disjointness plus bounded identity guards for
  dynamically uncertain argument overlap;
- whole-parameter access summaries for generic functions and trait methods,
  with every implementation checked against the declared access modes;
- conservative local aliasing of reference-bearing call results;
- rejection of active `~T` storage, capture, plain-value laundering, exclusive
  capability results, and exclusive reborrow overlap;
- acceptance of ordinary object results derived from `~T`, with local alias
  restrictions until every overlapping parent capability ends;
- `~val` logical writeback and conservative materialization;
- shared and exclusive `SharedCell` callbacks;
- nested shared callbacks and runtime conflict behavior;
- exact `SharedCell` signatures, exclusive `val` writeback, object-handle
  rebinding, and guard completion;
- scoped borrow helper parameters;
- normal generic-type parsing for `Borrow<T>` and nested inner types;
- rejection of the removed `borrow T` prefix syntax;
- absence of parser special cases for `borrow` as a contextual prefix operator;
- reservation, arity checking, and non-shadowing of the built-in `Borrow` name;
- legality after type-alias expansion and rejection of nested `Borrow`;
- acceptance of function types whose input is `Borrow<T>` without treating the
  function value as an active borrow;
- plain-place and temporary formation, full-invocation activation, and nested
  shared reborrowing;
- shared reborrow from exclusive access, exclusive reborrow restoration, and
  rejection of shared-to-exclusive upgrades;
- rejection of direct and nested borrowed result types;
- rejection of active `Borrow<T>` values in containers, aggregate fields,
  stored values, and ordinary generic arguments;
- rejection of removed `region`, region-mapping, `deref(...)`, `disjoint`, and
  `@borrow_contract` syntax;
- rejection of direct and wrapped borrow escapes;
- rejection of borrow flow into plain concrete parameters and callable
  adaptation in either direction;
- rejection of borrow erasure through ordinary generics;
- scalar extraction and independent reference-free `val` copies;
- preservation of origins through direct and nested mutable object fields,
  array elements, callable fields, destructuring, and `val` values containing
  mutable or otherwise alias-observing object handles;
- acceptance of a `StringSlice` produced from a borrowed receiver or projection,
  used after the callback ends, and still valid after the source cell is rebound;
  apply the same rule to other compiler-known results whose ordinary type
  contract guarantees stable immutable backing retained directly by the
  result;
- acceptance of explicit Borrow-aware helpers and nested shared or exclusive
  reborrows;
- rejection of ordinary methods, callable adaptation, and dynamic dispatch on
  borrowed receivers;
- rejection of every active-borrow closure capture, effect operation,
  suspension, task, host or Wasm import, host or Wasm export, FFI, and host call;
- parameter-level Borrow origins across module boundaries without published
  field or index paths;
- exact-call optimization facts are demand-driven, budgeted, cached, and never
  affect source acceptance;
- stable-field forwarding retains its proven exact-call cases and falls back
  for whole-parameter writes, dynamic calls, or missing field proof;
- mutable aggregate promotion retains its proven fresh exact-call cases and
  falls back for retention, result aliases, external access, suspension,
  identity guards, nested calls, or missing field proof;
- any optimization based on removed borrowed results, named regions,
  `disjoint`, or legacy provenance contracts is deleted or disabled;
- no optimization treats `~T` as unique outside its active scope, treats a
  coarse write as field-disjoint, or preserves a physical borrow across an
  opaque boundary;
- ordinary object alias and `~` behavior;
- internal wide-value physical borrowing;
- absence of `ViewIterator`, `Array.view_iter()`, and their public exports;
- ordinary `Iterator<T>` behavior and optimization.

After implementation, `npm test` and `npm run check` must pass. Compiler
performance must pass every acceptance criterion above. The validation report
must include the generalized scaling series, full-stack workloads, historical
V-499 controls, same-machine wall-time ratios, peak memory, retained summary
bytes, optimization dispositions, runtime results, and emitted Wasm sizes.
Ordinary code must have no new loan bookkeeping. Every material compiler or
runtime regression must be explained and accepted explicitly; the report is
part of the implementation, not follow-up work.
