# Memory and Mutation Safety

Status: Implemented

This document defines Voyd's source-level memory lifetime, aliasing, mutation,
and scoped-borrow rules. A difference in the compiler, standard library, or
published reference is a bug against this specification.

The design priorities, in order, are safety, developer experience, and
performance.

## 1. Source model

Voyd has four memory-safety concepts:

1. `T` is an ordinary value or a garbage-collected object handle.
2. `~T` grants exclusive access for a bounded call or local reborrow.
3. `Borrow<T>` grants shared access for a bounded call or callback.
4. `SharedCell<T>` provides runtime-checked scoped shared mutation.

Garbage collection determines whether an allocation is alive. Access checking
determines whether code may read or change a place or allocation at a particular
time. There is no source-level manual free operation and no persistent runtime
loan table for ordinary code.

A plain `T` never hides a source borrow. Scalars and value types are logically
copied. Copying an object handle preserves object identity without borrowing the
slot from which it was read. Aggregates are logically copied according to their
fields; object handles inside a copy remain aliases to their allocations.

## 2. Mutable access

`~T` is a bounded exclusive capability. While an exclusive access is active,
the covered place or object allocation MUST NOT be read or written through an
overlapping alias.

```voyd
obj Counter { value: i32 }

fn increment(~counter: Counter) -> void
  counter.value = counter.value + 1
```

For an object, `~obj` covers the handle place and the referenced allocation. For
a `val`, it is logical copy-in/copy-out access. A compiler that operates through
a physical reference MUST materialize and write back the logical value whenever
uncertainty makes that necessary.

Mutable access does not move or free the value. A callable MAY return an ordinary
object handle derived from an argument because the callee's exclusive access has
ended on return. The caller MUST conservatively treat a reference-bearing result
as a possible alias of every reference-bearing argument while an overlapping
parent capability remains active, except when the selected callable publishes one
of the bounded result-identity contracts in section 3.1.

### 2.1 Local duration

Ordinary mutable reborrows have local non-lexical duration. A reborrow begins
when exclusive access is activated and may end after its final local use. An
exclusive reborrow suspends its parent capability until the nested access ends.

An active exclusive capability MUST NOT be:

- stored in another value;
- captured by a closure;
- returned as a capability;
- kept across suspension or an effect boundary;
- passed to an unknown callable as plain `T`; or
- otherwise hidden from mutation analysis.

### 2.2 Overlap and runtime guards

Overlapping shared access is allowed. Any overlap involving a write requires
exclusivity. When two projected arguments may overlap, the compiler MUST do one
of the following:

1. prove the places disjoint;
2. insert a bounded runtime identity guard; or
3. reject the program.

Known unequal fields and stable constant indices may be proven disjoint locally.
A dynamic guard runs after argument and default evaluation and before parameter
access is activated. Equal identities cause a deterministic exclusivity-conflict
panic. The guard ends with the call and does not install persistent loan state.

## 3. Ordinary mutation summaries

A callable whose normalized signature does not contain `Borrow<T>` uses an
ordinary mutation summary. The summary contains exactly:

- one direct access mode per parameter: `unused`, `read`, or `write`;
- one reachable access mode per parameter: `unused`, `read`, or `write`;
- one ambient reference-bearing access mode: `unused`, `read`, or `write`;
- a reentrant-control bit; and
- a suspension bit.

The summary MUST NOT contain field, tuple, index, dereference, region, result, or
generic projection paths. Its state count MUST NOT depend on object field count,
projection depth, generic nesting, aggregate result shape, call-path count, or
trait implementation count.

Local analysis MAY distinguish fields and stable indices within one callable.
At a call or package boundary, that detail collapses to direct and reachable
whole-parameter modes. Direct access includes the parameter place, inline data,
and an object allocation named directly by the parameter. Reachable access
follows an object handle stored in that data. Different root identities can
prove direct roots distinct, but MUST NOT prove reachable graphs disjoint.

```voyd
fn update(~state: State) -> void
  state.profile.count = state.profile.count + 1
```

`update` publishes a direct read and reachable write for parameter zero.

### 3.1 Result identity

Result identity is a separate constant-size callable fact. It is not part of the
ordinary mutation-summary lattice. A callable publishes exactly one of:

- `conservative`, the default when no fact is present: the result may retain any
  reference-bearing argument identity;
- `detached`: no mutable identity visible from the result is retained from a
  reference-bearing argument;
- `fresh outer`: the returned outer mutable identity is new, while values
  reachable through it may retain argument identities; or
- `same place(parameter)`: the result is the exact exclusive place received in
  the named `~` parameter.

`@result(detached)` and `@result(fresh)` declare the two independent-result
contracts. `-> ~parameter` declares the same-place contract and has the ordinary
return type of that parameter:

```voyd
@result(detached)
fn parse(~cursor: Cursor) -> Result<Value, Error>

@result(fresh)
fn copied(source: Buffer) -> Buffer

fn set(~self, key: Key, value: Value) -> ~self
```

The compiler MUST check each declaration against its body. Missing or invalid
metadata is conservative at import and cache boundaries. Trait implementations
MUST satisfy the declared trait-method contract. Result identity MUST NOT affect
overload selection or code-generation ABI types.

A same-place result is an ephemeral exclusive capability. It may be ignored,
used immediately as the matching `~` receiver or argument of another same-place
call, or returned from a callable with the same contract. Phase-one source rules
MUST reject plain binding, aggregate storage, duplication, closure capture,
suspension or effects while the capability is live, conversion to plain `T`, and
reuse of the original place after transfer. Supporting a named moved capability
requires separate control-flow move-state semantics.

The fact has constant state per callable: an enum and, for `same place`, one
parameter index. Analysis MUST NOT infer result provenance through call graphs,
generic wrappers, aggregate shapes, or projection families.

### 3.2 Staged overlap

Staged overlap is a separate callable contract for an operation that captures
all reference-bearing source input before mutating one named destination:

```voyd
@staged(into: destination)
fn append(~destination: Buffer, source: Bytes) -> void
```

The destination MUST be a `~` parameter. Every control-flow path MUST perform
all accesses through other reference-bearing parameters before its first write
through the destination. A direct nested call MAY forward the relationship only
when the selected exact callable publishes a compatible staged contract.
Ambient reference-bearing access, reentrant control, suspension, effects, open
or ambiguous dispatch, and a source access after the first destination write
invalidate the declaration.

At a call site, the compiler MAY permit actual source/destination overlap only
for an exact, closed, unambiguous staged target. Missing package metadata is
conservative. The package fact contains one destination parameter index and is
not part of the ordinary mutation-summary lattice or result identity.

### 3.3 Private builder ownership

A recursive streaming operation MAY declare one private mutable destination:

```voyd
@builder(into: destination)
fn encode(~destination: Buffer, source: Value) -> void
```

The destination MUST be a `~` parameter. At each accepted call it MUST be a
locally created, unique fresh value, the selected target MUST be exact and
closed, and source inputs MUST NOT derive from that destination. The body MUST
NOT retain, return, capture, or publish a reference-bearing source through the
destination. Ambient reference-bearing access, reentrant control, suspension,
and effects invalidate the declaration. A recursive or forwarding call MAY
carry the relationship only through an exact compatible `@builder` contract.

This contract permits interleaved source reads and destination writes, so it
MUST remain separate from staged overlap. Its package fact contains one
destination parameter index and is independent of result identity and the
ordinary mutation-summary lattice. Missing metadata is conservative.

An ordinary signature is an upper bound. Plain `T` permits at most `read`; `~T`
permits at most `write`. A trait declaration provides the bound for dynamic
dispatch, and every implementation MUST fit it. Dynamic dispatch MUST NOT join
implementation-specific field footprints.

An open trait declaration is authoritative for dynamic calls. Unless the
declaration explicitly excludes them, ambient access defaults to `write` and
reentrant control and suspension default to true. The declaration's normalized
effect row is checked separately from mutation-summary inference.

A trait method MAY be marked `@isolated` only when it declares an explicit
empty effect row, `: ()`. The attribute applies to the full invocation and sets
the declaration bound's ambient access to `unused`, reentrant-control bit to
false, and suspension bit to false. It does not change direct or reachable
parameter modes. Every implementation and any default body MUST fit this bound.
Imported declarations MUST preserve the bound through the published ordinary
mutation summary; an importer MUST NOT inspect implementation bodies or rely on
a declaration name to recover it.

Every callable with a `~T` parameter MUST use callable-local backward CFG
liveness to prove that, while a capability or derived local alias remains live,
it does not:

- perform potentially overlapping ambient object access;
- invoke unknown or reentrant control;
- perform an effect; or
- suspend.

Branches and loop backedges join conservatively. Passing `~T` as the caller's
final use transfers the capability into the nested invocation. When the caller
uses the parent afterward, the parent stays suspended for the full nested call,
whose published hazards cover its full invocation.

While an exclusive capability is active, a known call is allowed only when its
summary is compatible. An unknown callback, suspension, or effect operation is
rejected. Ambient access is allowed only when local analysis proves it disjoint
from every active exclusive capability.

For `P` parameters, the summary lattice has at most `4P + 4` strict ascents.
The summary solver MUST use a dependency worklist, revisit callers only when a
dependency summary changes, and satisfy
`C + sum(H(callee) for each affected dependency edge)` evaluations. Local
liveness with `B` CFG blocks, `E` edges, and `L` capabilities MUST insert at
most `B * L` state facts and process at most `B + E * L` work items. Programs
without `Borrow<T>` MUST create zero explicit borrow-provenance facts.

## 4. The `Borrow<T>` type

`Borrow` is an unshadowable compiler-known type constructor with exactly one
type argument. It uses ordinary generic type syntax:

```voyd
fn inspect<T>(value: Borrow<T>) -> i32
```

The removed `borrow T` prefix is invalid syntax. `Borrow<Borrow<T>>` is always
invalid. `Borrow` is invariant: its inner type must match exactly after alias
expansion and inference. Formation does not perform subtype, trait-object, or
other representation-changing widening.

### 4.1 Legal positions

After type aliases are expanded, `Borrow<T>` is legal only as the complete type
of a callable input. This includes an input of a nested function type:

```voyd
fn run<T, R>(value: T, body: fn(value: Borrow<T>) : () -> R) -> R
```

The function value is ordinary and MAY be stored, passed, returned, or named by
a type alias. Its borrow becomes active only when that callable is invoked.

A local binding MAY have type `Borrow<T>` only when initialized from an active
borrowed parameter or one of its source-derived projections. The local alias
does not extend the invocation scope.

Every other normalized occurrence is invalid, including:

- callable results;
- object, structural-value, or aggregate fields;
- tuple or union members;
- module values;
- ordinary generic arguments;
- host, Wasm, or FFI signatures; and
- nested `Borrow` types.

### 4.2 Formation and activation

A plain `T` argument implicitly forms shared access when the selected input is
exactly `Borrow<T>`. The argument may be an addressable place or a temporary. A
temporary remains alive until the call returns.

The loan covers the argument place and every source-derived alias reached from
it. For an object handle, this includes the referenced allocation. A projection
may narrow the covered place but does not erase its origin.

Calls use this order:

1. evaluate the receiver and explicit arguments in source order;
2. evaluate omitted defaults in parameter order;
3. perform static checks and required identity guards;
4. activate parameter access;
5. run the callable; and
6. end parameter access when it returns.

A `Borrow<T>` parameter remains active for the complete invocation. Passing it
to another `Borrow<T>` input creates a nested shared reborrow. Passing it to a
plain `T` input is invalid, including through overload resolution, defaults,
imports, ordinary generics, and callable adaptation. A callable with a plain
input cannot satisfy a callable type with a borrowed input, and the reverse
adaptation is also invalid.

### 4.3 Exclusive scoped access

`~value: Borrow<T>` grants exclusive scoped access. It may be formed only from:

- an existing exclusive `~T` place;
- an existing `~Borrow<T>` through exclusive reborrow; or
- a successful compiler-known `SharedCell<T>` exclusive guard.

A shared `Borrow<T>` MUST NOT be upgraded to `~Borrow<T>`. An exclusive
capability may form a shared reborrow. Either kind of reborrow suspends the
parent exclusive capability until the nested call returns.

An exclusive scoped input may mutate or rebind according to the usual `~T`
rules. A `val` is written back logically. Object mutation affects the borrowed
allocation, and rebinding updates the borrowed handle slot.

## 5. Scoped origin and escape rules

Explicit borrow analysis tracks one origin per borrowed input across a call
boundary. Field and index projections are local facts and MUST NOT become public
projection families.

Every source-derived projection preserves its origin, including:

- object and nested fields;
- array and container elements;
- tuples, structural values, destructuring, and pattern bindings;
- callable fields and closures stored inside borrowed data;
- compiler-known operations; and
- object handles inside copied value types or aggregates.

Wrapping, copying, destructuring, generic substitution, overload resolution,
and callable adaptation MUST NOT erase an origin.

An active borrow MUST NOT be returned, stored, captured, suspended, passed
through a plain parameter, used as an ordinary generic argument, sent to an
effect operation, or exposed to a host/Wasm/FFI boundary.

Borrowed code may use direct projections, compiler-known operations, and direct
helpers whose input explicitly normalizes to `Borrow<T>` or `~Borrow<T>`.
Ordinary method dispatch, callable adaptation, and dynamic or open-trait
dispatch on a borrowed receiver are invalid. A shared borrow cannot invoke an
exclusive helper.

No closure may capture an active borrow, even if it appears to run immediately.
Nested code receives it through an explicit borrowed input. A callable with a
borrowed input cannot perform an effect operation or suspend before returning.

### 5.1 Independent results

A value derived while reading a borrow may leave the scope only when it belongs
to this closed classification:

- primitives and scalars copied by value;
- a reference-free value type, tuple, or structural value after logical copy;
- a fresh allocation whose type structure contains no derived mutable handle;
  or
- a compiler-known stable immutable retained handle.

`StringSlice` is the initial stable immutable retained type. It directly retains
immutable backing, and later mutation or rebinding of the source cannot change
that backing. Adding another type to this category requires a separate language
or standard-library decision; it MUST NOT be inferred from arbitrary bodies.

A copied object handle, closure, or aggregate containing an alias-observing
handle remains derived. A whole value type that contains an object handle is not
automatically independent, although its scalar fields may be copied out.

## 6. Borrowed results and containers

No callable may return a borrow, directly or inside another type:

```voyd
fn item_at<T>(items: Array<T>, index: i32) -> Borrow<T> // invalid
fn find<T>(items: Array<T>) -> Option<Borrow<T>>        // invalid
```

A borrowed value may not be stored in an object, structural value, tuple,
union, module binding, `SharedCell`, or ordinary generic container. APIs needing
zero-copy access use bounded callbacks:

```voyd
trait CollectionAccess<T>
  fn with_item<R>(
    self,
    index: i32,
    { body: fn(item: Borrow<T>) : () -> R }
  ): () -> Option<R>
```

Ordinary `Iterator<T>` remains the iteration protocol and returns `Option<T>`.
The removed `ViewIterator` protocol and `Array.view_iter()` API do not exist.

## 7. `SharedCell<T>`

`SharedCell<T>` provides deterministic runtime-checked access for state with
several long-lived owners. Its public callback signatures are:

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

The guard begins before the callback and ends after it returns. Shared callbacks
may nest. Any overlap involving an exclusive callback fails through the existing
panic or typed `Result` behavior. An exclusive callback writes a rebound value
back to the cell before ending the guard.

The generic result `R` MUST NOT hide an active borrow. Callback effect rows are
closed. `SharedCell` is single-threaded and does not block or synchronize
threads.

## 8. Effects, suspension, and host boundaries

An active mutable or scoped-borrow capability MUST NOT cross:

- an effect operation or handler continuation;
- a suspension point;
- a task boundary;
- closure capture;
- a host call;
- a host or Wasm import/export; or
- an FFI signature.

Ordinary owned values may cross these boundaries according to their normal type
and effect rules. Code MUST finish the scoped access and copy or construct an
independent result before invoking a continuation or starting later work.

Compiler-known intrinsics may implement `SharedCell` and internal physical
borrowing. They MUST NOT expose a source borrow to the host.

## 9. Internal physical borrowing

The compiler MAY represent an ordinary wide value with an internal readonly
borrow when this is unobservable. This is an optimization, not a source type or
public callable contract.

The compiler MUST materialize an ordinary value before storage, escape,
suspension, an opaque call, conflicting mutation, or any point where the
physical representation would change accepted source behavior.

## 10. Optimization facts

Finite safety summaries are separate from optimizer facts. A release
optimization MAY request a precise fact for one exact callable body. Such a fact
may include direct fields read or written, escape and retention, result aliasing,
external access, suspension, nested or unresolved calls, and identity guards.

An exact-call optimization fact MUST be:

- requested only for an actual candidate;
- limited to one exact body;
- work- and memory-budgeted;
- cached;
- conservative at recursive, nested, dynamic, or unresolved calls;
- excluded from safety summaries and safety fixed points; and
- irrelevant to whether source code is accepted.

When proof is unavailable, the optimizer uses the ordinary ABI or materialized
representation. It MUST NOT interpret a coarse whole-parameter summary as a
precise field contract.

In particular, no optimization may:

- depend on removed borrowed results or named-region metadata;
- assume a whole-parameter write is disjoint from a field or index;
- treat `~T` as unique beyond its active scope;
- retain a physical borrow across storage, suspension, escape, an opaque call,
  or conflicting mutation;
- join concrete dynamic implementations into a precise field footprint; or
- elide an identity guard without an independent local proof.

## 11. Removed language forms

The following forms are not part of Voyd:

- the `borrow T` prefix;
- borrowed results and borrow-carrying aggregates or generic containers;
- trait `region` declarations;
- implementation region mappings;
- `deref(...)` contract-place expressions;
- `disjoint` declarations;
- `@borrow_contract`;
- `ViewIterator`; and
- `Array.view_iter()`.

The words `region`, `disjoint`, and `deref` retain any ordinary identifier use
allowed by the general grammar. They have no borrow-contract declaration
meaning.

## 12. Diagnostics

A rejected access SHOULD identify the primary conflicting use and the origin or
active capability that makes it unsafe. When useful, diagnostics SHOULD identify
the call, capture, suspension, storage, or type position through which an access
would escape.

A diagnostic MAY suggest the smallest safe remedy: finish an access earlier,
copy an independent value, use an explicit Borrow-aware helper, split disjoint
storage, or use `SharedCell<T>` for intentionally shared mutable state.

## 13. Conformance requirements

A conforming implementation MUST test at least:

- ordinary alias overlap for `~T`, including callbacks, ambient state, dynamic
  calls, effects, and suspension;
- compatible known helpers and bounded runtime identity guards;
- whole-parameter summaries for functions, generics, traits, and SCCs;
- prevention of exclusive-capability storage, capture, return, and laundering;
- `Borrow<T>` parsing, reservation, arity, invariance, and legal positions after
  alias expansion;
- shared and exclusive formation, full-invocation duration, reborrow, and parent
  restoration;
- rejection of borrowed results, containers, fields, ordinary generics,
  callable adaptation, method receivers, captures, effects, and host boundaries;
- origin preservation through projections and aggregates;
- independent scalar, reference-free value, and `StringSlice` results;
- all four `SharedCell<T>` callbacks, writeback, nesting, and runtime conflict
  behavior;
- ordinary iterator behavior and internal wide-value physical borrowing;
- zero explicit-borrow facts for programs without `Borrow<T>`; and
- demand, budget, cache, fallback, and emitted behavior for every optimization
  that consumes exact-call facts.

Raw linear memory, unsafe facilities, host-language FFI implementation safety,
and multithreaded transfer or synchronization remain outside this specification.
