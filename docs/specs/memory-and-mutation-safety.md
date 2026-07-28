# Memory and Mutation Safety

Status: Proposed ideal design

This document defines Voyd's memory-lifetime, aliasing, mutation-safety, and
borrow-contract model. It is design-authoritative rather than a description of
the current compiler.

Where the implementation, standard library, or published documentation differs
from this document, the difference is migration work. Existing behavior does
not constrain the rules below.

The design priorities, in order, are:

1. safety;
2. developer experience;
3. performance.

## Part I: Guide

### The model in six rules

1. Garbage collection keeps reachable allocations alive.
2. Shared reads may coexist, but an active writer may not overlap another
   active access to the same storage.
3. A plain `T` is a semantic value, never a hidden source-level borrow.
4. Copying an object handle preserves object identity without borrowing the
   slot from which the handle was read.
5. A genuine storage view uses `borrow T` and carries provenance.
6. Advanced public APIs may describe mutation and borrowed-result provenance
   with checked regions and `@borrow_contract`.

### Lifetime and access are separate

Garbage collection answers whether an allocation remains alive. Borrow
checking answers whether code may access that allocation or another storage
place in a particular way.

```voyd
obj Account {
  balance: i32
}

let ~account = Account { balance: 10 }
let observer = account
```

`observer` is another handle to the same `Account`. The allocation remains
alive while either handle is reachable. Merely possessing either ordinary
handle does not create a shared loan.

Sequential mutation and observation are valid:

```voyd
deposit(~account, 5)
print(observer.balance) // observes 15
```

A conflict exists only when shared and exclusive accesses are simultaneously
active, or when an explicit borrowed view remains live:

```voyd
inspect(account, while: () =>
  deposit(~account, 5) // error if `inspect` keeps shared access active
)
```

This is a single-threaded access rule. A future concurrency model must add
transfer and synchronization rules before ordinary handles can cross threads.

### Shared and exclusive access

Ordinary access is shared and read-only:

```voyd
let account = Account { balance: 10 }
let balance = account.balance
```

Use `~` when code needs exclusive mutable access:

```voyd
let ~account = Account { balance: 10 }

fn deposit(~account: Account, amount: i32) -> void
  account.balance = account.balance + amount

deposit(~account, 5)
```

`~account` does not move, free, or transfer the GC allocation. It activates an
exclusive access capability for the places used by the operation.

### Borrows end after their final use

Voyd infers the duration of explicit and mutable borrows:

```voyd
let ~account = Account { balance: 10 }
let ~current = account

deposit(~current, 5)
// `current` is not used again, so the reborrow has ended.

deposit(~account, 2)
```

A borrow remains active when a later use requires it:

```voyd
let ~current = account
let before = account.balance // error: `current` remains live
deposit(~current, 5)
```

An ordinary object alias is not an implicit borrow. A future use of an ordinary
handle does not retroactively create a loan across unrelated intervening
operations.

### Places, slots, and referenced allocations

A **place** is addressable storage. Bindings, fields, tuple positions, and
stable container elements can be places:

```voyd
account
account.balance
pair.0
values.at(3)
```

The slot holding an object handle and the referenced allocation are distinct:

```voyd
self.source = replacement // writes the `source` field slot
self.source.lower()        // writes the referenced String allocation
```

The compiler must preserve that distinction in inference, contracts,
diagnostics, optimization facts, and separate-compilation summaries.

Different fixed fields may be proven disjoint:

```voyd
obj State {
  left: Counter,
  right: Counter
}
```

Accessing `state.left` need not block independent access to `state.right`.
Unknown indexed overlap remains conservative unless it qualifies for the
bounded runtime identity guard defined below.

### Plain values are independent of source storage

Plain assignment, argument passing, aggregate construction, capture, and
return produce semantic values:

```voyd
fn at(self, index: i32) -> T
```

The result does not borrow the field or element slot from which it was read.

- Scalars are copied.
- `val` values are logically copied.
- Object handles are copied cheaply and preserve object identity.
- Aggregates are logically copied according to their fields.
- Object handles inside copied values remain aliases to their referenced
  allocations.

This rule concerns expression and API semantics. It does not redefine the
language's `val` and `obj` categories.

### Physical borrowing is an optimization

The compiler may temporarily represent a plain value with a physical readonly
borrow when that representation is unobservable. It must materialize the value
before:

- an ownership-demanding use;
- escape or storage;
- an opaque boundary;
- conflicting mutation;
- or any point at which the representation would change accepted source
  behavior.

An internal physical borrow is not part of the value's type or public callable
contract.

### Explicit borrowed values

`borrow T` is a prefix type modifier for a value that refers to storage owned
elsewhere:

```voyd
fn borrow_at(self, index: i32) -> borrow T
```

`borrow` binds to the following type:

```voyd
borrow T
Option<borrow T>
Result<borrow T, LookupError>
(borrow Key, borrow Value)
borrow Option<T>
```

These two types are intentionally different:

```voyd
Option<borrow T> // an ordinary Option with a borrowed Some payload
borrow Option<T> // borrowed access to an Option stored elsewhere
```

Borrowed results are shared views in the initial design. Exclusive borrowed
results are not part of this proposal. Scoped APIs such as `SharedCell.with_mut`
may grant exclusive access to borrowed storage through the existing `~`
parameter marker.

Borrow provenance follows borrowed values through optionals, results, tuples,
structural values, nominal values, generic wrappers, pattern matching, and
closures wherever such containment is legal.

### Ordinary and view iterators

The ordinary iterator contract returns values:

```voyd
trait Iterator<T>
  fn next(~self) -> Option<T>
```

This code is valid:

```voyd
let first = iterator.next()
let second = iterator.next()
use(first)
```

Advancing the cursor does not borrow or invalidate a prior value. A returned
object handle may still alias the same object allocation as another handle.

A zero-copy view iterator is a separate API:

```voyd
trait ViewIterator<T>
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(
    mutates: cursor,
    returns_from: source
  )
  fn next(~self) -> Option<borrow T>
```

The `Option` is an ordinary value. Only its `Some` payload borrows source
storage.

### Borrow contracts

Regions are symbolic sets of places used at representation-hiding boundaries:

```voyd
trait CacheView<K, V>
  region entries
  region statistics
  disjoint entries, statistics

  @borrow_contract(
    mutates: statistics,
    returns_from: entries
  )
  fn get(~self, key: K) -> Option<borrow V>
```

The attribute uses Voyd's existing labeled-argument syntax. Multiple regions
use arrays:

```voyd
@borrow_contract(
  reads: metadata,
  mutates: [cursor, statistics],
  returns_from: [primary_source, fallback_source]
)
```

`reads` bounds caller-observable shared reads that are not already implied by a
write or returned borrow. Reading a `mutates` region while updating it and
reading a `returns_from` region to produce the borrowed result need not be
listed again.

An implementation maps abstract regions to private representation places:

```voyd
impl ViewIterator<T> for ArrayViewIterator<T>
  region cursor = self.cursor
  region source = deref(self.items)

  api fn next(~self) -> Option<borrow T>
    // ...
```

`deref(place)` is a contract-place expression, not a runtime function. It maps
the region to the allocation referenced by a handle slot rather than to the
slot itself.

Implementations inherit the trait contract. They do not repeat the annotation.
The compiler checks default implementations and every override.

### Receiver access uses callable footprints

`~self` requests exclusive mutation capability, but it does not activate a
loan over the entire transitive object graph.

For concrete code, the compiler infers the exact caller-observable read and
write footprint. Public summaries serialize that footprint. A declared
`@borrow_contract` bounds it across open traits and other abstraction
boundaries.

When no precise summary or contract is available, the conservative fallback is
the receiver's direct and inline storage. Transitively referenced allocations
are not included merely because they are reachable through `self`; accesses to
them require their own inferred or declared provenance.

### Stable StringSlice

An ordinary `StringSlice` is a stable semantic value. It retains immutable
backing storage directly rather than retaining a view of a mutable `String`
shell:

```voyd
obj String {
  backing: StringStorage
}

obj StringSlice {
  backing: StringStorage,
  start: i32,
  byte_count: i32
}
```

Mutating a `String` replaces its backing handle:

```voyd
let slice = text.slice(bytes: 0, len: 3)
text.lower()
use(slice) // observes the original bytes
```

Other handles to the same `String` object observe its new contents. Existing
slices continue to observe their retained backing.

The initial implementation may copy on mutation. Reference-counted copy-on-
write or compiler-proven unique in-place mutation may be added when
unobservable. Safety and accepted source behavior must not depend on those
optimizations.

An API that intentionally exposes mutable or reusable source storage must use
an explicit borrowed type rather than ordinary `StringSlice`.

### SharedCell

`SharedCell<T>` is the explicit single-threaded abstraction for intentional
shared or reentrant mutation.

Its callback parameters are explicit scoped borrows:

```voyd
impl<T> SharedCell<T>
  fn with<R>(
    self,
    body: fn(value: borrow T) : () -> R
  ): () -> R

  fn with_mut<R>(
    self,
    body: fn(~value: borrow T) : () -> R
  ): () -> R
```

The callback may return ordinary values:

```voyd
let balance = cell.with((value) => value.balance)
```

It may not return, store, capture, suspend with, or otherwise escape its
borrowed parameter or a borrowed projection:

```voyd
let escaped = cell.with((value) => value) // error
```

`SharedCell` checks runtime state:

- multiple shared callbacks may coexist;
- one exclusive callback may run;
- a conflict deterministically panics;
- `try_with` and `try_with_mut` return a typed conflict error;
- state is restored on every normal or handled exceptional exit;
- callbacks have a closed non-suspending effect row.

`SharedCell` is not thread-safe.

### Bounded runtime exclusivity

The initial automatic runtime fallback is deliberately narrow. It handles
unknown overlap between stable, call-scoped projected places using identity
guards:

```voyd
transfer(~accounts.at(left), ~accounts.at(right))
```

The compiler evaluates the receiver, explicit arguments, and defaults in
source order, then compares the relevant place identities. Conceptually:

```text
(accounts backing identity, left)
(accounts backing identity, right)
```

- Statically equal places are compile errors.
- Statically disjoint places need no guard.
- Dynamically uncertain but comparable places receive a deterministic guard.
- Equal runtime identities produce an exclusivity-conflict panic.
- Unstable, escaping, suspending, or otherwise unbounded accesses are rejected
  unless an explicit safe dynamic abstraction governs them.

This guard proves call-scoped disjointness. It does not install a runtime loan,
reader count, side-table entry, or GC-finalized token, so there is no dynamic
release operation.

The optimizer may eliminate or hoist a guard only when it proves that place
identity, source evaluation order, access duration, and conflict behavior are
unchanged. Required guards remain enabled in every build mode.

General escaped runtime loans are not part of this proposal. Use explicit
borrow contracts for static views and `SharedCell` for longer-lived dynamic
shared mutation.

### Closures, callbacks, effects, and continuations

An ordinary object handle captured by a closure remains an ordinary alias, not
a hidden borrow. Accesses made when the closure is invoked participate in the
normal call access rules.

An explicit borrow or mutable capability:

- may be captured only by a proven non-escaping closure;
- may be returned only when its origin is inferred or declared by
  `returns_from`;
- may be wrapped in a provenance-tracked, scope-bounded aggregate;
- must not be stored somewhere that can outlive its origin or erase its
  provenance;
- must not cross a suspension or continuation boundary that may resume later;
- must not be passed to an opaque host boundary without a safe contract.

Returning an explicit borrow activates a shared loan over its mapped source
places. The loan remains active until the returned borrowed value or containing
aggregate's final possible use.

Unknown callbacks and calls remain conservative for the duration in which they
may access or retain borrowed values. Possessing an ordinary handle before or
after such a call does not create a permanent shared loan.

### Performance

The safety model permits:

- deferred or eliminated value materialization;
- scalar replacement;
- copy-on-write;
- stable load and store forwarding;
- no-alias call lowering;
- loop-invariant load preservation;
- vectorization using proven-disjoint places;
- removal of redundant identity guards;
- localized `SharedCell` barriers.

No optimization is required for correctness. Optimized and unoptimized
execution must preserve value independence, object identity, evaluation and
effect order, mutation visibility, and required conflict behavior.

## Part II: Normative Specification

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are normative.

### 1. Scope

This specification defines:

- GC-observed allocation lifetime;
- shared and exclusive access;
- mutable reborrows and non-lexical duration;
- places, projections, dereferenced allocations, and provenance;
- semantic values and object aliases;
- explicit borrowed types;
- callable access summaries;
- abstract regions and borrow contracts;
- bounded call-scoped runtime identity guards;
- closure, callback, effect, and continuation restrictions;
- `SharedCell`;
- stable ordinary `StringSlice`;
- optimization equivalence.

It does not define raw linear-memory safety, FFI safety, unsafe facilities, or
multithreaded synchronization.

### 2. Semantic values and object aliases

A plain `T` MUST be a semantic value independent of the source slot from which
it was read.

This rule applies to:

- assignment;
- argument passing;
- return;
- aggregate construction and storage;
- closure capture.

Copying a `val` MUST preserve logical value independence.

Copying an object handle MUST:

- preserve the referenced allocation's identity;
- keep that allocation reachable as required by GC;
- preserve alias provenance to the allocation;
- not create a borrow of the binding, field, element, or aggregate slot from
  which the handle was copied.

Merely possessing or retaining an ordinary object handle MUST NOT create a
shared loan. Reads performed through a handle are shared accesses for their
actual access duration.

### 3. Borrowed types

The type grammar is extended with:

```ebnf
BorrowedType = "borrow", Type;
```

`borrow` binds to the immediately following type. Consequently,
`Option<borrow T>` and `borrow Option<T>` are distinct.

A value of type `borrow T`:

- refers to storage owned elsewhere;
- carries its origin provenance;
- keeps any required allocation reachable;
- prevents overlapping mutation for its live duration;
- MUST NOT outlive the origin's valid access scope.

Borrowed provenance MUST compose through supported aggregates and generic
wrappers. Pattern matching MUST transfer the provenance to the extracted
payload.

A provenance-tracked aggregate MAY contain borrowed values, including when its
runtime representation uses a fresh heap allocation such as
`Some<borrow T>`. The aggregate and every copy or projection carrying the
borrow MUST remain bounded by the origin's access scope. A borrowed value MUST
NOT be inserted into pre-existing, global, opaque, or otherwise longer-lived
storage unless the compiler proves that storage is bounded by the same origin.

An explicitly borrowed result MAY cross a return boundary when its origin is
inferred for a concrete callable or covered by `returns_from` in the public
contract. Returning it activates a retained shared loan over the mapped source
places. The result's liveness determines the loan duration, and the result
keeps required origin allocations reachable. Returning borrowed provenance
through a plain `T`, from an undeclared origin, or beyond a scoped callback
boundary is forbidden.

Borrowed results are shared borrowed values. This specification does not
define an exclusive borrowed-result type.

### 4. Places and provenance

A place consists of a root followed by zero or more projections:

```text
Place = Root Projection*
Projection =
  Field(name)
  | Tuple(index)
  | Element(index)
  | Discriminant
  | Dereference
```

`Dereference` identifies the allocation referenced by a handle slot. It MUST
remain distinct from that slot.

Provenance MUST survive any operation that preserves a storage view or object
alias, including assignment, projection, wrapping, destructuring, capture,
return, generic substitution, and callable composition.

The implementation MUST keep separate provenance categories for:

1. semantic values;
2. returned or retained object-allocation aliases;
3. explicit borrowed storage;
4. compiler-only physical borrows.

### 5. Overlap and compatibility

A place overlaps itself and its inline containing storage. Known distinct
fixed fields and tuple positions MAY be proven disjoint.

Indexed projections overlap unless stable storage and distinct indices are
proven or a bounded runtime identity guard establishes disjointness.

A handle slot and its dereferenced allocation do not overlap merely because
the slot contains the handle. Two dereferenced handles overlap when they refer
to the same allocation and overlapping subplaces.

Simultaneously active accesses to overlapping places are compatible only as
follows:

| First | Second | Allowed |
| --- | --- | --- |
| shared | shared | yes |
| shared | exclusive/write | no |
| exclusive/write | shared | no |
| exclusive/write | exclusive/write | no |

Statically known conflicts MUST be rejected.

### 6. Loan activation and duration

A non-escaping loan begins when its access is activated and ends after its
final possible use.

The compiler MUST account for control-flow paths, loops, early exits, closure
uses, retention, effects, and continuation capture.

Calls are evaluated in this order:

1. receiver;
2. explicit arguments in source order;
3. omitted defaults in parameter order;
4. required static checks and runtime identity guards;
5. activation of call accesses;
6. callable execution;
7. end of non-retained call accesses.

Optimized execution MUST preserve the same observable order.

### 7. Reborrowing

An exclusive capability may be reborrowed. While the reborrow is live, the
source capability MUST NOT be used in a conflicting way. Ending the reborrow
restores source use when no other escape or active access prevents it.

### 8. Physical borrow optimization

The implementation MAY use a physical readonly borrow to represent a plain
semantic value only while the representation is unobservable.

It MUST materialize before escape, ownership demand, opaque access,
conflicting mutation, or any point at which retaining the physical borrow
would reject a program accepted by value semantics.

Physical borrows MUST NOT appear in source types or public callable contracts.

### 9. Callable summaries and receiver footprints

For concrete callables, the compiler SHOULD infer:

- shared and exclusive parameter accesses;
- direct and dereferenced read/write footprints;
- retained borrowed provenance;
- returned object aliases;
- returned borrowed provenance;
- callback escape behavior;
- suspension behavior.

Public summaries MUST serialize the caller-visible subset required for
separate compilation.

`~self` requests exclusive capability. Activated access MUST be limited to the
checked inferred or declared footprint. It MUST NOT automatically include the
transitive object graph.

When no precise summary is available, the conservative receiver footprint is
its direct and inline storage. Dereferenced allocations require independent
provenance.

### 10. Region and contract syntax

A trait may declare abstract regions and disjointness:

```ebnf
RegionDeclaration = "region", Identifier;
DisjointDeclaration = "disjoint", Identifier, (",", Identifier)+;
```

A method contract uses:

```voyd
@borrow_contract(
  reads: region_or_array,
  mutates: region_or_array,
  returns_from: region_or_array
)
```

All labels are optional. `reads` is an upper bound on caller-observable shared
reads not already implied by a write or returned borrow. `mutates` is an upper
bound on caller-observable writes. `returns_from` applies only to explicit
borrowed portions of the result and declares a retained shared access to their
origins.

Region identifiers in the attribute are symbolic compile-time names, not
runtime values or strings.

For every implementation:

- inferred caller-observable reads MUST be a subset of the union of `reads`,
  `mutates`, and `returns_from`;
- inferred writes MUST be a subset of `mutates`;
- explicit borrowed-result origins MUST be a subset of `returns_from`;
- every declared disjoint pair MUST map to non-overlapping places;
- plain result portions MUST NOT acquire borrowed provenance.

A default trait body and every overriding implementation MUST be checked.

### 11. Region mappings

An implementation maps regions inside its `impl` body:

```voyd
impl Trait<T> for Concrete<T>
  region cursor = self.cursor
  region source = deref(self.source)
```

Mapping expressions are compile-time contract-place expressions.
`deref(place)` maps to the allocation referenced by the place. It is not a
runtime callable.

Mappings MUST preserve representation privacy while satisfying the public
contract. They MUST compose through generics, wrappers, dynamic dispatch,
modules, packages, and separate compilation.

### 12. Trait defaults

An ordinary trait method returning plain `T` promises value semantics:

```voyd
trait Iterator<T>
  fn next(~self) -> Option<T>
```

Implementations MUST NOT expose a source borrow through any plain portion of
the result.

Advanced traits returning borrowed values MUST declare enough provenance for
safe open-world calls. Missing explicit-borrow provenance is a compile error;
it MUST NOT be inferred as an undocumented public contract.

### 13. Bounded runtime identity guards

The compiler MUST support a bounded runtime fallback when all of these hold:

- uncertainty is limited to overlap among identified projected places;
- every place has stable, comparable identity;
- accesses are confined to one non-suspending call;
- no checked access escapes or is retained;
- all other alias relationships are statically safe.

The guard compares complete place identities before activating call accesses.
It installs no persistent runtime loan state.

The compiler MUST:

- reject statically equal conflicting places;
- omit guards for statically disjoint places;
- deterministically panic for equal runtime identities;
- retain required guards in all build modes;
- report both conflicting places when debug metadata is available.

Unbounded or unstable cases MUST be rejected unless an explicit safe dynamic
abstraction applies.

### 14. SharedCell

`SharedCell<T>` MUST expose scoped borrowed callback parameters:

```voyd
fn with<R>(self, body: fn(value: borrow T) : () -> R): () -> R
fn with_mut<R>(self, body: fn(~value: borrow T) : () -> R): () -> R
```

Its runtime state is:

```text
Unborrowed
Shared(reader_count > 0)
Exclusive
```

Conflicting `with` and `with_mut` operations MUST panic deterministically.
`try_with` and `try_with_mut` MUST return typed conflicts.

The callback MUST NOT escape a borrowed value or projection and MUST NOT
suspend. Runtime state MUST be restored on every normal or handled exceptional
exit. Release MUST NOT depend on GC finalization.

### 15. String and StringSlice

An ordinary `StringSlice` MUST retain stable immutable backing storage rather
than a mutable `String` shell.

Mutating a `String` MUST preserve all existing ordinary slices. It may replace
the String's backing, copy, use copy-on-write, or mutate uniquely proven
unobservable backing.

An ordinary slice MUST NOT block source `String` mutation. A source-tied view
over mutable or reusable storage MUST use an explicit borrowed type.

### 16. Closures, effects, and opaque boundaries

Capturing an ordinary object handle preserves an ordinary alias and MUST NOT
silently create a borrow.

An explicit borrow or mutable reborrow MUST NOT escape through:

- a plain return or a return outside inferred or declared `returns_from`
  provenance;
- pre-existing, global, opaque, or otherwise longer-lived storage;
- escaping closure capture;
- retained callback;
- suspended continuation;
- opaque host storage.

A fresh provenance-tracked aggregate, including a heap-backed aggregate, MAY
contain a borrowed value when the aggregate cannot outlive the origin and does
not erase provenance.

A mutable or explicit borrow MUST NOT cross an operation that may suspend and
resume later.

Unknown calls are conservative for borrowed and active-access behavior during
the call. They MUST NOT permanently downgrade ordinary handles merely because
those handles remain reachable.

### 17. Diagnostics

A borrow diagnostic SHOULD identify:

- the active access or borrowed value;
- the conflicting attempted access;
- both relevant places or regions;
- the final use retaining an earlier borrow;
- the callable contract or unknown boundary involved.

A runtime identity conflict SHOULD identify both projected places when debug
metadata is available.

Suggested remedies SHOULD distinguish consuming a value sooner, requesting an
owned value, shortening an explicit borrow, splitting storage, correcting a
contract, and deliberately using `SharedCell`.

### 18. Optimization equivalence

Optimized execution MUST preserve:

- source acceptance;
- plain-value independence;
- object identity and aliasing;
- evaluation and effect order;
- mutation visibility;
- static errors;
- required runtime conflict panic and typed-error behavior.

Region contracts have no runtime representation. Runtime identity guards and
`SharedCell` state are observable only through their required conflict
behavior.

### 19. Conformance requirements

A conforming implementation MUST test:

- plain assignment, arguments, returns, aggregate storage, and capture;
- scalar and wide-`val` independence;
- object-handle identity without source-slot borrowing;
- sequential mutation followed by observation through another ordinary handle;
- active shared/exclusive conflicts;
- NLL and reborrowing;
- field, tuple, slot, dereference, and constant-index disjointness;
- dynamic-index static rejection, guard success, and guard conflict;
- call and default evaluation order;
- internal physical borrow materialization;
- `Option<borrow T>` and `borrow Option<T>` distinction;
- construction, return, and pattern extraction of `Option<borrow T>`;
- borrowed payload propagation through aggregates and patterns;
- rejection when a borrowed aggregate is inserted into longer-lived storage;
- retained borrowed-result loans ending after final use;
- cursor-only ViewIterator calls while an earlier source borrow remains live;
- source mutation rejected until a returned source borrow's final use;
- invalid borrow escape;
- region parsing, mapping, validation, and disjointness;
- contract checking across traits, generics, wrappers, modules, and dynamic
  dispatch;
- ordinary Iterator retained-result behavior;
- ViewIterator cursor/source disjointness;
- reusable-buffer conflicts;
- stable StringSlice across String mutation;
- explicit source-tied string-view conflicts if such an API exists;
- closure, callback, effect, continuation, and opaque-call restrictions;
- all `SharedCell` state transitions and callback restrictions;
- optimized/unoptimized equivalence;
- actionable diagnostics.

### 20. Completion criteria

This proposal is complete only when:

- plain values never acquire source-visible borrowed provenance;
- slot and dereferenced-allocation provenance are distinct;
- ordinary object aliases do not become hidden loans;
- `borrow T` and borrowed aggregate payloads are implemented;
- `@borrow_contract` read, mutation, and returned-provenance bounds, regions,
  mappings, and validation are implemented;
- callable contracts serialize across every public boundary;
- `~self` uses checked access footprints;
- ordinary Iterator uses `next(~self) -> Option<T>` with direct cursor storage;
- ViewIterator uses `Option<borrow T>`;
- bounded runtime identity guards are implemented and diagnosed;
- SharedCell uses explicit scoped borrowed callback parameters;
- ordinary StringSlice has stable backing semantics;
- the standard-library API audit and migration are complete;
- user documentation reflects this model;
- conformance, compiler, std, integration, optimized/unoptimized, typecheck, and
  test-audit suites pass;
- compile-time, summary-size, runtime, allocation, and generated-Wasm deltas
  are measured.

After those criteria land, this document may move from **Proposed ideal
design** to **Implemented**.
