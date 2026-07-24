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
- A mutable borrow cannot overlap another mutable borrow or a read.
- The compiler ends non-escaping borrows after their final use.
- Use `SharedCell<T>` when several long-lived owners must mutate the same state.

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

`~param: T` is an exclusive borrow for the call. It does not transfer memory
ownership.

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

## Read-only aliases

A read-only alias blocks mutation only until its final use:

```voyd
let ~account = Account { balance: 10 }
let snapshot = account
let before = snapshot.balance
deposit(~account, 5) // valid: `snapshot` is no longer used
```

If a read-only alias is returned, stored, captured by an escaping closure, or
passed to a function that retains it, the unique capability becomes shared.
It cannot be used for mutation afterward.

APIs that retain ordinary reference parameters should document that behavior.
The compiler records retention as part of the callable contract, including
across module boundaries.

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
- Indexed elements overlap unless both indices are known constants and the
  container guarantees stable, disjoint element storage.
- Trait and structural views keep the original root's provenance.

When aliasing cannot be proven safe, the compiler rejects the access
conservatively.

## Calls and evaluation order

Voyd evaluates a call in this order:

1. The receiver and explicit arguments are evaluated in source order.
2. Omitted defaults are evaluated in parameter order.
3. Shared and mutable call borrows are activated.
4. The call runs.
5. Non-retained call borrows end when the call returns.

Optimized and unoptimized programs use the same order. This allows a default or
argument to read a receiver before the receiver's mutable call borrow begins.

## Closures and effects

Mutable borrows cannot escape through returns, storage, or closure captures.
They also cannot cross a suspending effect or another continuation boundary
that might resume later.

Read-only captures remain borrowed until the closure's final use. If the
closure escapes, the captured root becomes permanently shared in that scope.

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

The borrowed callback value or a reference-like projection cannot be returned,
stored, or captured. Copied results such as numbers may be returned.

`SharedCell` does not block, synchronize threads, or provide thread safety.
