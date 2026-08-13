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

### End ordinary exclusive access at its final local use

Ordinary `~T` duration is local and non-lexical. It begins when exclusive
access is activated and ends once the capability and every local alias derived
from it have no possible later use on the current control-flow path.

The checker must determine this from the current callable's control-flow graph.
It must not inspect callers, recursively inspect callees, or propagate
projection provenance through the call graph to find the end of an ordinary
exclusive access. Branches and loops join conservatively when any continuing
path may use the capability again.

A call made after the final local use is not constrained by the ended
capability:

```voyd
fn update(~state: State, notify: () : () -> void) -> void
  state.count = state.count + 1
  // state and its derived aliases have no later use.
  notify() // allowed even when notify is opaque
```

The exclusive capability remains live across a call when it may be used later:

```voyd
fn update(~state: State, notify: () : () -> void) -> void
  state.count = state.count + 1
  notify() // requires a compatible bounded summary or guard
  state.updated = true
```

For a live capability, call compatibility is determined only from the callee's
finite ordinary summary. The safety checker must not recursively inspect the
callee or construct arbitrary alias or projection provenance to prove the call
safe. If the summary is insufficient, the compiler must use an allowed bounded
runtime guard or reject the call.

A nested callable that receives `~T` gets a bounded reborrow. When the caller
uses the parent capability after the nested call, the parent remains suspended
for the full nested invocation. The nested callable ending its own local use
early does not resume the caller's parent capability early. Hazards published
by the nested callable therefore describe its full invocation, including work
performed after its own parameter's final local use.

When passing `~T` is the caller's final use, the caller may end or transfer its
capability at the call. There is then no parent capability to resume. The nested
callable still determines the final use of its own parameter with local
control-flow analysis.

```voyd
fn inner(~state: State, notify: () : () -> void) -> void
  state.count = state.count + 1
  notify() // after inner's final local use

fn outer(~state: State, notify: () : () -> void) -> void
  inner(~state, notify) // rejected if notify is opaque
  state.updated = true // the parent would resume here

fn finish(~state: State, notify: () : () -> void) -> void
  inner(~state, notify) // allowed: passing state is finish's final use
```

`inner` publishes the reentrant-control hazard for its full invocation even
though its own exclusive use ends before `notify`. `outer` must account for
that hazard because its parent capability resumes. `finish` can transfer its
final capability into the call, so no suspended parent remains.

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

- one direct access mode per parameter: `unused`, `read`, or `write`;
- one reachable access mode per parameter: `unused`, `read`, or `write`;
- one ambient reference-bearing access mode: `unused`, `read`, or `write`;
- whether the callable invokes unknown or reentrant control; and
- whether it may suspend.

Direct access touches the parameter place, an object allocation named directly
by the parameter, or inline data stored in the parameter. Reachable access
follows an object handle stored in that data and touches another allocation.
For example, rebinding `parent.child` is a direct write to `parent`, while
mutating `parent.child.count` is a direct read plus a reachable write through
`parent`. A `val` that contains an object handle uses the same distinction.

Two access modes conflict when they may touch the same place or allocation and
at least one is `write`. Direct access can use exact local place disjointness or
exact root identity. Reachable access may touch any allocation reached after
following a stored object handle. When either side relies on reachable access,
different root identities are insufficient proof of disjointness.

The summary has no field, tuple, index, dereference, region, result, or generic
projection paths. Its number of states must not depend on object field count,
projection depth, generic nesting, returned aggregate shape, call-path count,
or trait implementation count.

Local analysis may distinguish fields and stable indices inside one callable.
At an ordinary call or package boundary, access collapses to the parameter's
direct and reachable modes. A function such as this publishes a direct read and
reachable write for parameter zero:

```voyd
fn update(~state: State) -> void
  state.profile.count = state.profile.count + 1
```

Ordinary signatures provide access upper bounds for both modes: plain `T`
permits at most `read`, and `~T` permits at most `write`. A concrete body may
refine either mode to `unused`. Every trait implementation is checked against
the declared parameter upper bounds, and a dynamic caller uses those bounds.
Dynamic dispatch must not join field-sensitive implementation contracts.

Call compatibility also uses the callable's normalized effect row. The effect
row comes from ordinary effect typing and is not inferred or widened by the
mutation-summary solver. A non-empty, unknown, or polymorphic effect row is
treated as reentrant control while an overlapping exclusive capability or
scoped borrow is active. Allowing a checked non-reentrant effect requires a
separate contract decision.

An open trait declaration is the authoritative contract for dynamic calls. In
the initial model, source syntax provides no promise that an open implementation
avoids ambient reference-bearing state or reentrant control. Those hazards
therefore default to `write` and `true` for an open dynamic call. Suspension
also defaults to `true` unless the normalized declaration excludes it. The
declaration's effect row is authoritative; an unknown or polymorphic row is
hazardous. Implementations must fit the declared parameter modes, suspension,
and effect row. A closed or statically resolved call may use its concrete finite
summary. Future syntax may publish tighter ambient or reentrancy bounds, but an
implementation must never be inspected transitively to tighten an open call.

Every callable with a `~T` parameter must prove that, while one of its exclusive
capabilities remains locally live, it does not perform potentially aliasing
ambient object access, invoke incompatible reentrant control, perform an
effect, or suspend. This is a local body obligation for ordinary functions,
trait methods, and every trait implementation. Calls made after the
capability's final local use are not restricted by that capability. This makes
dynamic `~T` dispatch safe without joining implementation-specific provenance.
A statically resolved helper may access state while a capability is live only
when local analysis proves it disjoint.

The published ambient, reentrant-control, suspension, and effect hazards cover
the callable's full invocation, including code after its own parameter's final
local use. This full-call contract protects a caller whose parent capability is
suspended and later resumes.

While an exclusive capability is active:

- a known call is allowed when its bounded summary is compatible;
- an unknown callback, suspension, or effect operation is rejected;
- ambient object access is rejected unless local analysis proves it disjoint;
  and
- a reference-bearing call result is conservatively treated as possibly
  aliasing every reference-bearing argument for the rest of the active scope.

The last rule is local to the caller. It is not a returned-origin contract
published by the callee.

Direct and reachable modes are separate safety facts. A runtime identity guard
can prove that two exact object handles name different allocations. Comparing
two root handles cannot prove that their reachable object graphs are disjoint.
When a reachable access may overlap through different roots, the compiler must
prove disjointness locally without traversing the object graph at runtime or
reject the program.

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

### Check ordinary aliases during scoped access

Scoped access must remain compatible with ordinary aliases for its full
invocation:

- active `Borrow<T>` permits overlapping shared reads and forbids potentially
  overlapping writes; and
- active `~Borrow<T>` forbids potentially overlapping reads and writes.

The checker applies these rules to direct arguments, local aliases, callback
captures, module state, dynamic calls, and effects. A call inside the scope is
checked from its direct and reachable parameter modes, ambient access mode,
reentrant-control and suspension bits, and normalized effect row. The checker
must not recursively inspect the callee to recover a better contract.

A known exact root alias may use a bounded identity guard. Different root
identities do not prove that reachable allocations are disjoint. Unknown
reference-bearing ambient access, reentrant control, suspension, or effects are
rejected when they could conflict with the active scoped access.

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

The runtime guard protects access made through the `SharedCell` API. It cannot
observe access through an ordinary alias of the stored object or of an object
reachable from it. Static compatibility rules therefore also apply for the
full callback invocation:

- while `Borrow<T>` is active, a potentially overlapping ordinary write is
  forbidden;
- while `~Borrow<T>` is active, a potentially overlapping ordinary read or
  write is forbidden; and
- the rules cover callback captures, parameters, module state, dynamic calls,
  effects, and transitive calls through their finite published summaries.

For example, keeping an ordinary alias before putting an object in a cell does
not bypass exclusive access:

```voyd
let state = State { count: 0 }
let cell = SharedCell<State>::init(state)

cell.with_mut((~borrowed) =>
  inspect(state) // rejected or guarded: state may be the stored object
  borrowed.count = borrowed.count + 1
)
```

The compiler may compare an explicit ordinary object handle with the guarded
cell value using a bounded identity guard. Unequal root handles prove only that
the roots differ. They do not prove that objects reachable through those roots
are disjoint. Potentially overlapping reachable access requires a local proof
or rejection; the compiler must not walk the object graph at runtime.

Unknown reference-bearing ambient access is incompatible with an active cell
borrow. A known finite summary may admit shared reads during `with`, but no
ordinary access that could conflict with `with_mut`. Borrow non-escape and the
cell's runtime guard remain separate required protections.

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
that parameter type and the finite call hazards above. An open dynamic call
uses the declaration's conservative ambient, reentrancy, suspension, and
effect contract. Borrow-aware receiver syntax may be considered later, but this
decision does not require it.

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
- ordinary mutation summaries conservatively distinguish direct and reachable
  whole-parameter access and describe ambient access, reentrant control, and
  suspension;
- open dynamic calls use their declared parameter and effect bounds plus
  conservative ambient, reentrancy, and unknown-suspension defaults;
- uncertain ordinary call results are treated locally as possible aliases of
  their reference-bearing arguments;
- an active exclusive capability cannot be stored, captured, returned,
  suspended, or erased as plain `T` at an unknown call;
- `Borrow<T>` cannot escape, be stored, or be erased by generics;
- an active `Borrow<T>` forbids potentially overlapping ordinary writes, and
  an active `~Borrow<T>` forbids potentially overlapping ordinary reads and
  writes, including access outside the `SharedCell` API;
- shared access cannot be upgraded to exclusive access;
- source-derived projections keep their scoped origin unless an independent
  copy is proven;
- borrowed values may call only compiler-known operations or explicitly
  Borrow-aware helpers;
- active borrows cannot be captured or cross effect, suspension, task, or
  continuation boundaries;
- uncertain overlap is guarded or rejected;
- a root identity guard is never used as proof that reachable object graphs are
  disjoint;
- internal physical borrows materialize before ownership becomes observable;
- host and Wasm imports, host and Wasm exports, FFI, and host boundaries cannot
  receive a source borrow.

The existing out-of-scope areas remain out of scope: raw linear memory, unsafe
facilities, FFI implementation safety, and future multi-threaded transfer and
synchronization.

## Developer Experience

Most current application code in this repository is expected to keep working.
Applications use ordinary values, `~`, and `SharedCell` callbacks rather than
borrowed results. An opaque callback is allowed after the final local use of an
exclusive capability.

Some callback-heavy mutation APIs may require restructuring when an exclusive
capability remains live across the callback:

```voyd
fn update(~state: State, log: fn(String) : () -> void) -> void
  state.count = state.count + 1
  log("updated")
  state.updated = true // keeps state live across log
```

This call requires a compatible bounded callback summary or guard. When neither
is available, the initial alternatives are to finish exclusive mutation before
invoking the callback, pass an independent value to a statically resolved
helper, or use an explicit runtime-checked abstraction such as `SharedCell`. A
future callable effect or capture contract may accept more cases without
restoring general provenance inference.

Open dynamic calls are also conservative while an overlapping capability is
active because the current trait syntax cannot promise the absence of ambient
or reentrant access. Code can end the capability before the dynamic call, use a
statically resolved helper, or accept a bounded guard where exact root identity
is sufficient. Reachable graph overlap is rejected unless local structure
proves disjointness.

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

Ordinary mutation summaries must use numeric direct, reachable, and ambient
access modes plus fixed hazard bits. Their equality must not depend on
serializing structural contracts. The effect row is an already-normalized
typing input rather than mutation-summary state.

For a callable with `P` parameters, the mutation-summary lattice permits at
most `H = 4P + 4` strict ascents: two each for the direct and reachable
three-state mode of every parameter, two for the ambient three-state mode, and
one each for the reentrant-control and suspension bits. Implementations may use
a lower equivalent bound. They must not add a component whose height depends on
fields, projections, results, generic shape, call paths, or implementations.

The solver must operate with a dependency worklist and visit only callers whose
dependency summary changed. For `C` affected callables and dependency edges
`caller -> callee`, one solve may perform at most:

```text
C + sum(H(callee) for each affected dependency edge)
```

summary evaluations. Queue deduplication may reduce this count. Strongly
connected components do not relax the bound. The implementation must count
strict summary ascents, dependency enqueues, summary evaluations, and SCC body
visits so the bound can be asserted directly.

Local exclusive-liveness analysis must use a monotone bitset dataflow. For `B`
control-flow blocks, `E` local control-flow edges, and `L` tracked local
capabilities or derived aliases, it may insert at most `B * L` live-state facts
and process at most `B + E * L` block work items. The implementation must count
both values and assert these bounds. Callee size and call-graph depth are not
inputs to this analysis.

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

The optimizer must enforce both a per-body fact budget and a compile-wide fact
budget. It must count requests, cache hits, cache misses, body visits, analysis
operations, budget exhaustion, and conservative bailouts by reason. Exhausting
either budget selects the ordinary materialized fallback and cannot affect
source acceptance.

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
- treats unequal root handles as proof of disjointness when either access may
  reach shared subobjects;
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
4. mutation graphs that vary direct and reachable access, shared subobjects,
   direct calls, open dynamic calls, callbacks, ambient state, effects, identity
   guards, nested reborrows, and SCC shape;
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
- local exclusive-liveness block visits, state insertions, and convergence
  iterations;
- explicit borrow-analysis time;
- callable and call-edge count;
- ordinary summary evaluations and SCC reevaluations;
- explicit borrow fact count;
- projection-family and widening count;
- retained summary bytes and peak resident memory;
- optimized runtime and emitted Wasm size for affected fast paths; and
- optimization acceptance and fallback counts by reason;
- exact-call fact requests, cache hits, cache misses, body visits, analysis
  operations, and per-body or compile-wide budget exhaustion; and
- ordinary summary strict ascents, dependency enqueues, and solver-bound usage.

The implementation must satisfy these structural gates:

- increasing ordinary DTO field count does not increase interprocedural
  mutation-summary size;
- ordinary mutation analysis creates no projection families or widenings;
- ordinary exclusive-liveness work is bounded by the current callable's local
  control-flow graph and local place count, satisfies the `B * L` state and
  `B + E * L` work-item formulas above, and is independent of callee graph size;
- a program with no `Borrow<T>` creates zero explicit-borrow provenance facts;
- ordinary summary evaluations do not exceed the finite-lattice formula above;
- for each of the two largest generated DTO size doublings, ordinary summary
  evaluations, retained summary bytes, and local-liveness state insertions each
  grow by no more than `2.25x`; exceeding that ratio is a scaling failure;
- the selected-provider graph no longer routes ordinary `~T` functions through
  detailed borrow analysis;
- exact-call optimization analysis stays within its configured work and memory
  budgets; and
- removing the legacy contracts does not silently disable an accepted
  optimization without a recorded disposition and benchmark result.

Before post-change performance measurements begin, the implementation PR must
record numeric per-body and compile-wide optimizer budgets and numeric wall-time
and memory regression limits for every required workload family. Those values
may be changed later only with an explained design change and a new clean
measurement run. This prevents a final result from selecting its own gate.

The report must include the compiler revisions, hardware, commands, sample
counts, warmup policy, distributions or ranges, raw counters, configured
budgets, budget usage, and same-machine ratios. Scaling conclusions must use
the generated size series, not two endpoints. Counter and state-growth gates
are authoritative across machines. Regressions must not be hidden with higher
timeouts, fewer workers, test-only source batching, or benchmark-specific
compiler branches.

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
- Unknown callbacks, open dynamic calls, effects, and uncertain ambient object
  access are rejected while they may overlap active exclusive mutation.
- Calls that may reach shared subobjects can be rejected even when their root
  object handles differ.
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
3. Introduce the finite direct, reachable, and ambient access modes, fixed
   hazard bits, normalized-effect input, dependency worklist, and required
   solver counters. Assert the finite-lattice evaluation bound.
4. Route ordinary `~T` safety through that summary while preserving exclusive
   isolation, local place precision, bounded identity guards, and conservative
   callback, ambient-access, result-alias, effect, reachable-graph, and
   suspension rules. Implement local final-use analysis and full-invocation
   parent suspension for nested reborrows.
5. Add the unshadowable built-in `Borrow<T>` type, replace `borrow T`, and
   remove the parser's contextual prefix and custom generic-inner-type handling.
6. Enforce normalized type-position, exact callable, formation, activation,
   reborrow, exclusive-access, and explicit Borrow-aware call rules.
7. Migrate all four `SharedCell<T>` methods to `Borrow<T>` and `~Borrow<T>`.
   Enforce compatibility with pre-existing ordinary aliases in addition to the
   cell's runtime guard.
8. Preserve only parameter-level scoped origins across Borrow-aware calls. Keep
   field and index projections local. Apply the closed independent-result
   classification.
9. Reject borrowed results, active borrows inside stored values and ordinary
   generic arguments, ordinary borrowed-receiver dispatch, closure capture,
   effects, every host or Wasm import and export, every FFI signature, and every
   host call.
10. Add per-body and compile-wide budgets and counters for bounded exact-call
    optimization facts, migrate justified consumers, and remove every
    optimization whose old proof is no longer valid.
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
- acceptance of an opaque callback after the final local use of `~T`;
- rejection, guarding, or bounded-summary admission of the same callback when
  `~T` remains live after it;
- conservative exclusive-liveness joins through branches and loops;
- proof that ordinary last-use analysis inspects only the current callable's
  control-flow graph and does not recursively inspect callees;
- rejection when a nested reborrow ends its own local use before a reentrant
  call but its caller resumes the parent capability after the nested call;
- acceptance of the same nested call when passing the parent capability is the
  caller's final use;
- rejection of reentrant alias access through unknown callbacks, module state,
  closures, effects, suspension, and dynamic calls with uncertain access while
  an overlapping exclusive capability remains live;
- acceptance of statically resolved helpers whose bounded summaries are
  compatible with an active exclusive capability;
- local field and stable-index disjointness plus bounded identity guards for
  dynamically uncertain exact-root overlap;
- direct and reachable whole-parameter modes for generic functions, object
  graphs, and `val` values containing object handles;
- rejection of a reachable shared-object conflict through unequal root handles,
  proving that a root identity guard does not establish graph disjointness;
- finite trait-method parameter and effect contracts, with every implementation
  checked against the declaration;
- conservative ambient, reentrant-control, suspension, and effect defaults for
  open dynamic calls while an overlapping capability is active;
- conservative local aliasing of reference-bearing call results;
- rejection of active `~T` storage, capture, plain-value laundering, exclusive
  capability results, and exclusive reborrow overlap;
- acceptance of ordinary object results derived from `~T`, with local alias
  restrictions until every overlapping parent capability ends;
- `~val` logical writeback and conservative materialization;
- shared and exclusive `SharedCell` callbacks;
- nested shared callbacks and runtime conflict behavior;
- rejection or a sufficient exact-root guard when a `SharedCell` callback
  accesses a pre-existing ordinary alias of the stored object;
- rejection of reachable alias access through a different root during a
  `SharedCell` callback unless local structure proves disjointness;
- acceptance of compatible ordinary shared reads during `SharedCell.with` and
  rejection of potentially overlapping ordinary writes;
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
- exact-call optimization facts are demand-driven, cached, constrained by
  declared per-body and compile-wide budgets, and never affect source
  acceptance;
- exact-call fact counters cover cache misses, body visits, analysis operations,
  budget exhaustion, and conservative bailouts;
- ordinary summary evaluations satisfy the finite-lattice formula, and the
  generated scaling series satisfies the `2.25x` doubling gates;
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
