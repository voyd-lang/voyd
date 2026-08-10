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

The parser must remove all special-case handling for `borrow T`. This includes
removing `borrow` as a contextual prefix operator and removing its custom
generic-inner-type parsing. `Borrow<T>` must use the same generic type syntax as
other type constructors. Backwards compatibility for `borrow T` is not
required.

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

Generic helpers that accept scoped access must spell `Borrow<T>` on the
parameter:

```voyd
fn inspect<T>(value: Borrow<T>) -> i32
  // ...
```

This keeps ordinary generic code free from hidden loan propagation.

### Keep method calls safe

A borrowed receiver may call a method while the borrow is active. The method
must not store, capture, or return the borrowed receiver.

An independent result is allowed:

```voyd
cell.with((value) =>
  value.length()
)
```

If a method result aliases the borrowed receiver, the call is rejected. The
compiler must not erase that relationship by typing the result as plain `T`.

When the compiler cannot prove that a method is safe for a borrowed receiver,
it must reject the call. Separate compilation must preserve the small result
and retention summary needed for this check.

### Keep closure and effect boundaries strict

A borrow may be captured only by a closure that is proven to run and finish
inside the same scope. It may not enter an escaping closure, task, suspended
continuation, or unknown host call.

Until Voyd has a checked direct-effect category, a scoped borrow may not cross
an effect operation that could capture or resume the continuation later.
Direct effects are a separate design decision.

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
- borrowed method receivers cannot escape through method results;
- borrows cannot cross suspending or continuation-capturing operations;
- uncertain overlap is guarded or rejected;
- internal physical borrows materialize before ownership becomes observable;
- unknown FFI and host boundaries cannot receive a borrow without a checked
  scoped contract.

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

1. Replace `borrow T` with `Borrow<T>` and remove the parser's contextual prefix
   operator and custom generic-inner-type handling for `borrow`.
2. Remove `ViewIterator`, `Array.view_iter()`, and their exports.
3. Reject `Borrow<T>` in all result positions.
4. Reject `Borrow<T>` inside containers, aggregates, stored values, and ordinary
   generic arguments.
5. Add focused diagnostics for direct, wrapped, generic, method, capture,
   storage, suspension, and host-boundary escapes.
6. Preserve scoped parameter and callback behavior used by `SharedCell`.
7. Remove named-region and `@borrow_contract` syntax and semantics.
8. Remove borrowed-result propagation from compiler summaries, module
   interfaces, and dependency caches.
9. Make detailed borrow analysis demand-driven.
10. Update the memory-safety specification, language reference, conformance
    manifest, and test inventory.

## Validation

Validation must cover observable behavior at the smallest useful boundaries.

Required cases include:

- shared and exclusive `SharedCell` callbacks;
- nested shared callbacks and runtime conflict behavior;
- scoped borrow helper parameters;
- normal generic-type parsing for `Borrow<T>` and nested inner types;
- rejection of the removed `borrow T` prefix syntax;
- absence of parser special cases for `borrow` as a contextual prefix operator;
- rejection of direct and nested borrowed result types;
- rejection of `Borrow<T>` in containers, aggregate fields, stored values, and
  ordinary generic arguments;
- rejection of removed `region`, region-mapping, `deref(...)`, `disjoint`, and
  `@borrow_contract` syntax;
- rejection of direct and wrapped borrow escapes;
- rejection of borrow erasure through ordinary generics;
- safe method calls on borrowed receivers;
- rejection of method results that retain or alias a borrowed receiver;
- rejection of escaping closures, suspension, and unknown host calls;
- conservative behavior across modules and dynamic trait dispatch;
- ordinary object alias and `~` behavior;
- internal wide-value physical borrowing;
- absence of `ViewIterator`, `Array.view_iter()`, and their public exports;
- ordinary `Iterator<T>` behavior and optimization.

After implementation, `npm test` and `npm run check` must pass. Compiler
performance must be measured before and after. Runtime benchmarks must confirm
that ordinary code has no new loan bookkeeping or material regression.
