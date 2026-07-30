---
order: 85
---

# Borrow Checking

Voyd uses garbage collection for memory lifetime and borrowing for safe access.
Garbage collection keeps objects alive. Borrow checking prevents conflicting
reads and writes.

The short version:

- Ordinary object access is shared and read-only.
- `~T` is temporary exclusive access to a `T`.
- Active shared and exclusive accesses to the same storage cannot overlap.
- The compiler ends non-escaping borrows after their final use.
- Use `SharedCell<T>` when several long-lived owners must mutate the same state.

> **Current scope:** Voyd supports explicit `borrow T` views, checked regions
> and `@borrow_contract` declarations, scoped `SharedCell` callbacks, and
> bounded call-scoped identity guards. These features are explicit: a plain
> `T` remains a value and does not become a loan because it is aliased.

## Unique and shared access

A fresh mutable binding has unique access:

```voyd
obj Account {
  balance: i32
}

let ~account = Account { balance: 10 }
```

A binding without `~` is shared:

```voyd
let account = Account { balance: 10 }
// account.balance = 20  // error: shared bindings cannot be mutated
```

Functions and methods request exclusive access with `~`:

```voyd
fn deposit(~account: Account, amount: i32) -> void
  account.balance = account.balance + amount

deposit(~account, 5)
```

`~param: T` requests exclusive mutable access for the part of the call that
uses it. It does not transfer memory ownership.

## Reborrowing

A mutable alias temporarily reborrows its source:

```voyd
let ~account = Account { balance: 10 }
let ~current = account
deposit(~current, 5)
// `current` is no longer used, so its borrow ends here.
deposit(~account, 2)
```

The source cannot be read or mutated while the reborrow is still active:

```voyd
let ~current = account
let before = account.balance // error: `current` is still live
deposit(~current, 5)
```

Borrow regions are inferred from final uses. There is no lifetime annotation
syntax.

## Ordinary values and object aliases

A plain `T` is a semantic value. Assignment, argument passing, return,
aggregate storage, and closure capture do not borrow the source slot.

Object values are handles. Copying a handle preserves the referenced
allocation's identity without borrowing the binding or field that held it:

```voyd
let ~account = Account { balance: 10 }
let observer = account
deposit(~account, 5)
print(observer.balance) // observes 15
```

Possessing an ordinary alias does not keep a shared access active. An actual
read is shared for its access duration, and a call that reads through one alias
cannot overlap a mutable call access through another alias to the same
allocation.

The compiler may represent a plain value with an internal physical borrow when
that is unobservable. It materializes the value before storage, escape, an
opaque boundary, conflicting mutation, or another ownership-demanding use.
This optimization does not change accepted source programs or public callable
contracts.

## Explicit borrowed views

Use `borrow T` when an API returns a view into storage owned elsewhere:

```voyd
fn item_at(self, index: i32) -> borrow Item
```

The borrow carries its source provenance through aggregates and pattern
matching. It cannot outlive or escape its source.

`borrow` applies to the next type, so these types are different:

```voyd
Option<borrow Item> // an ordinary Option with a borrowed Some payload
borrow Option<Item> // a borrowed view of an Option stored elsewhere
```

## Ordinary and view iterators

An ordinary iterator returns values:

```voyd
trait Iterator<T>
  fn next(~self) -> Option<T>
```

Earlier results remain usable after the cursor advances. Use a view iterator
only when the result should borrow stable source storage:

```voyd
trait ViewIterator<T>
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> Option<borrow T>
```

`Array<T>.iter()` uses the ordinary contract. `Array<T>.view_iter()` uses the
explicit view contract.

## Conflicting calls

All call borrows remain active for the entire call. Known aliases are checked
by provenance, not only by variable name.

```voyd
fn transfer(~from: Account, ~to: Account) -> void
  // ...

transfer(~account, ~account) // error: two exclusive borrows overlap
```

The same rule covers a receiver and its arguments:

```voyd
account.merge(account) // error when `merge` mutably borrows `self`
```

## Places and projections

A place is a binding or a projected part of one, such as a field, tuple
position, or indexed element.

- A whole object overlaps each of its fields.
- The same field overlaps itself.
- Different statically known fields and tuple positions are disjoint.
- A slot holding an object handle is distinct from the referenced allocation.
- Indexed elements overlap unless both indices are known constants and the
  container guarantees stable, disjoint element storage.
- Trait and structural views keep the original root's provenance.

For example, replacing `holder.child` writes the field slot. Mutating
`holder.child.value` writes the allocation referenced by that slot. Callable
access summaries preserve this difference across modules, generics, closures,
effects, and trait dispatch.

A mutable receiver does not automatically borrow every object reachable from
it. The compiler limits the activated access to the callable's checked
caller-visible read and write footprint. When a precise footprint is
unavailable, direct and inline receiver storage is the conservative fallback;
referenced allocations remain separate.

When stable call-scoped projections might overlap, the compiler may insert a
bounded identity guard if the operation is eligible. The guard covers only the
call and traps deterministically on conflict. Escaping borrows, unstable
projections, effects, and continuation boundaries are not eligible and remain
compile-time errors.

## Borrow contracts

Traits can name caller-visible regions and state exactly what a method reads,
mutates, or returns a borrow from:

```voyd
trait CacheView<V>
  region entries
  region statistics
  disjoint entries, statistics

  @borrow_contract(
    mutates: statistics,
    returns_from: entries
  )
  fn get(~self, key: i32) -> Option<borrow V>
```

Implementations map each region to a representation place. The compiler checks
that an implementation stays within the declared contract, and code generation
consumes the checked contract through the program codegen view.

## Calls and evaluation order

Voyd evaluates a call in this order:

1. The receiver is evaluated.
2. Explicit arguments are evaluated in source order.
3. Omitted defaults are evaluated in parameter order.
4. Static access checks run.
5. Shared and mutable call accesses are activated.
6. The call runs.
7. Non-escaping call accesses end when the call returns.

Optimized and unoptimized programs use the same order. This allows a default or
argument to read a receiver before the receiver's mutable call borrow begins.

## Closures and effects

Mutable borrows cannot escape through returns, storage, or closure captures.
They also cannot cross a suspending effect or another continuation boundary
that might resume later.

Capturing an ordinary object handle preserves an ordinary alias, not a hidden
borrow. Reads made when the closure runs participate in the normal call-access
rules.

## SharedCell

`SharedCell<T>` is the explicit single-threaded tool for intentionally shared
mutable state:

```voyd
use std::shared_cell::SharedCell

obj Session {
  token: i32
}

let session = SharedCell(Session { token: 1 })

session.with_mut((~value) =>
  value.token = 2
)

let token = session.with((value) => value.token)
```

Its public operations are:

```voyd
SharedCell(value)
cell.with((value) => result)
cell.with_mut((~value) => result)
cell.try_with((value) => result)
cell.try_with_mut((~value) => result)
```

`with` allows nested readers. `with_mut` requires exclusive access. A conflict
in either operation produces a deterministic panic. The `try_` forms return a
`SharedCellBorrowError` instead:

- `AlreadyMutablyBorrowed`
- `AlreadySharedBorrowed`

The callback has a closed `: ()` effect row, so it cannot suspend or perform
arbitrary effects while the runtime borrow is active. Compute effectful work
before the callback, then make a short update inside it.

The callback value has scoped borrowed semantics: it and its borrowed
projections cannot be returned, stored, captured, or passed to an opaque
retaining call. Copied results such as numbers may be returned.

The public callback signatures make the scoped borrow explicit:

```voyd
fn with<R>(self, body: fn(value: borrow T) : () -> R): () -> R
fn with_mut<R>(
  self,
  body: fn(~value: borrow T) : () -> R
): () -> R
```

`SharedCell` does not block, synchronize threads, or provide thread safety.

## Stable StringSlice values

An ordinary `StringSlice` retains immutable backing storage. Mutating its
source `String` replaces the source backing instead of changing an existing
slice:

```voyd
let ~source = "hello"
let slice = source.slice(bytes: 1, len: 3)
source.replace(old: "ell", with: "i")
print(slice) // "ell"
```

A `StringSlice` is therefore a stable value, not a source loan, and it does not
block later mutation of the source string. APIs that intentionally expose
mutable or reusable storage use an explicit borrowed type instead.
