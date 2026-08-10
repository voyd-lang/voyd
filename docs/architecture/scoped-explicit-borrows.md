# Scoped Explicit Borrows

Status: Proposed

Decision date: 2026-08-09

## Summary

Voyd will keep explicit borrows, but a borrow will only be valid inside a
bounded call or callback.

Voyd will remove borrowed results, borrow-carrying containers, named regions,
borrow contracts, and `ViewIterator`.

This keeps the current safety level. It removes safe but unused forms of
zero-copy programming. It also gives the compiler a smaller memory-safety model
to analyze.

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

## Decision

### Keep four memory-safety concepts

Voyd will keep this small source model:

1. `T` is an ordinary value or GC-managed object handle.
2. `~T` grants exclusive access for a bounded call or callback.
3. `Borrow<T>` grants shared access for a bounded call or callback.
4. `SharedCell<T>` provides explicit runtime-checked shared mutation.

Garbage collection continues to manage allocation lifetime. Borrow checking
continues to prevent overlapping access that includes mutation.

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
origin.

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
and the reverse adaptation is also rejected. The borrowed-receiver rule below
is the only exception.

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

The callback can return an independent value:

```voyd
let length = collection.with_item(0, body: (item) =>
  item.length()
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
the same scoped origin. Its declared field or element type does not erase that
origin.

```voyd
obj Wrapper {
  inner: Box
}

fn leak(value: Borrow<Wrapper>) -> Box
  value.inner
// error: value.inner is still scoped to value
```

This rule applies to:

- object fields and nested fields;
- array and container elements;
- tuples, structural values, destructuring, and pattern bindings;
- callable fields and closures stored inside borrowed data;
- method and operator results; and
- object handles inside a copied `val` or other aggregate.

Local type inference must preserve the scoped origin. Wrapping, copying,
destructuring, generic substitution, overload resolution, and callable
adaptation must not erase it.

A proven independent copy may leave the scope as a plain value:

- primitives and scalars are independent copies;
- a `val`, tuple, or structural value is independent only when none of its
  result paths contains a mutable object, mutable storage handle, closure, or
  other alias whose later use could observe or mutate the borrowed origin; and
- a newly allocated object is independent only when its reachable result paths
  do not retain such an alias derived from the borrowed origin.

A reference-bearing result may still be independent when its ordinary type
contract guarantees stable immutable backing that the result retains directly.
`StringSlice` is the current example. Sharing immutable retained storage does
not provide later access to mutable borrowed state. This is an ordinary type
contract, not a borrowed-result exception.

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

### Keep method calls safe

A borrowed receiver may call a concrete method while the borrow is active. This
is a special receiver rule; it does not convert the receiver to plain `T`. The
method must not store, capture, or return the borrowed receiver or any
source-derived alias.

A shared `Borrow<T>` receiver cannot call a `~self` method. An exclusive
`~Borrow<T>` receiver may call a `~self` method through an exclusive reborrow.

An independent result is allowed:

```voyd
cell.with((value) =>
  value.length()
)
```

If a method result aliases the borrowed receiver, the call is rejected. The
compiler must not erase that relationship by typing the result as plain `T`.
The projection and independent-copy rules above apply to every result path.

When the compiler cannot prove that a method is safe for a borrowed receiver,
it must reject the call. Separate compilation must preserve the small result
and retention summary needed for this check. The summary must cover reads,
writes, retention, returned origins, and suspension. Safety admission must use
semantic facts, never optional optimizer facts.

Dynamic or open-trait dispatch on a borrowed receiver is rejected. A concrete
implementation may be used only when semantic resolution proves the exact
target before optimization. A trait method may still accept an explicit
`Borrow<T>` non-receiver parameter; every implementation is checked against
that parameter type.

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

Every public summary must describe at least the behavior the implementation can
perform. An optimizer may use more precise facts, but optimizer facts are never
required for correctness.

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
- `~T` remains exclusive for its active scope;
- `Borrow<T>` cannot escape, be stored, or be erased by generics;
- shared access cannot be upgraded to exclusive access;
- source-derived projections keep their scoped origin unless an independent
  copy is proven;
- borrowed method receivers cannot escape through method results;
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

Current application code in this repository is expected to keep working.
Applications use ordinary values, `~`, and `SharedCell` callbacks. They do not
use borrowed results.

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

This decision should reduce mandatory compiler work by removing:

- returned-loan provenance;
- borrow propagation through result containers and generic wrappers;
- borrowed-result SCC inference;
- named-region binding, mapping, and validation;
- borrowed-result information in package and cache summaries;
- flow-sensitive analysis triggered only by possible borrowed results.

The exact gain is not known. The change must be measured with the existing
memory-safety benchmark and the whole Web package compile.

The compiler should also make borrow analysis demand-driven. Callables that
cannot create, receive, or use scoped access should not build detailed borrow
facts.

### Runtime performance

Ordinary Voyd code already has no persistent runtime loan table. This decision
is expected to be runtime-neutral for ordinary code.

Bounded identity guards remain available for dynamic uncertainty. Internal
physical borrowing and iterator specialization remain available for runtime
performance.

## Consequences

### Benefits

- The safety model has fewer states and a smaller proof surface.
- Plain values and ordinary generic code have simpler meaning.
- `SharedCell` keeps its useful scoped API.
- The compiler no longer supports unused borrowed-result machinery.
- Public semantic and cache summaries can become smaller.
- The optimizer can keep precise facts without making them part of the safety
  contract.

### Costs

- Linear borrowed-result APIs are unavailable.
- Zero-copy access sometimes requires callback nesting.
- A borrowed receiver cannot call a method that may return or retain it.
- Active borrows cannot be captured or used by effectful code.
- Dynamic trait dispatch on a borrowed receiver is unavailable.
- Host, Wasm, and FFI boundaries cannot accept source borrows.
- Some safe programs become invalid until a real use case justifies a new
  design.
- Compiler performance improvements are expected but must be measured.

## Alternatives Considered

### Keep the current general borrow model

Rejected because its complexity is much larger than its demonstrated use. It
also makes ordinary generic and cross-module analysis borrow-aware.

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

1. Add the unshadowable built-in `Borrow<T>` type, replace `borrow T`, and
   remove the parser's contextual prefix and custom generic-inner-type handling.
2. Enforce normalized type-position, exact callable, formation, activation,
   reborrow, and exclusive-access rules.
3. Migrate all four `SharedCell<T>` methods to `Borrow<T>` and
   `~Borrow<T>`.
4. Preserve scoped origins through projections, calls, methods, copied values,
   destructuring, overloads, and local inference.
5. Reject borrowed results, active borrows inside stored values and ordinary
   generic arguments, closure capture, effects, dynamic borrowed-receiver
   dispatch, every host or Wasm import and export, every FFI signature, and
   every host call.
6. Remove `ViewIterator`, `Array.view_iter()`, and their exports.
7. Remove named-region and `@borrow_contract` syntax and semantics.
8. Remove borrowed-result propagation from compiler summaries, module
   interfaces, and dependency caches. Keep only access, retention, returned
   origin, and suspension facts required by scoped concrete calls.
9. Make detailed borrow analysis demand-driven.
10. Update the memory-safety specification, language reference, conformance
    manifest, and test inventory.

## Validation

Validation must cover observable behavior at the smallest useful boundaries.

Required cases include:

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
  apply the same rule to other results whose ordinary type contract guarantees
  stable immutable backing retained directly by the result;
- safe method calls on borrowed receivers;
- safe `~self` calls from `~Borrow<T>` and rejection from shared `Borrow<T>`;
- rejection of method results that retain or alias a borrowed receiver;
- rejection of every active-borrow closure capture, effect operation,
  suspension, task, host or Wasm import, host or Wasm export, FFI, and host call;
- conservative summaries across modules and rejection of dynamic or open-trait
  dispatch on borrowed receivers;
- ordinary object alias and `~` behavior;
- internal wide-value physical borrowing;
- absence of `ViewIterator`, `Array.view_iter()`, and their public exports;
- ordinary `Iterator<T>` behavior and optimization.

After implementation, `npm test` and `npm run check` must pass. Compiler
performance must be measured before and after. Runtime benchmarks must confirm
that ordinary code has no new loan bookkeeping or material regression.
