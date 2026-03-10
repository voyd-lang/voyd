---
order: 240
---

# Enums

`enum` defines a named union of nominal variants.

```voyd
pub enum MaybeDrink
  None
  Some<T> { value: T }
```

Construct variants through the enum namespace.

```voyd
let drink: MaybeDrink<i32> = MaybeDrink::Some<i32> { value: 10 }
```

Unit variants are also valid, including generic unit variants.

```voyd
pub enum Signal
  Idle
  Ready<T>

let signal: Signal<i32> = Signal::Ready<i32> {}
```

Match on enum variants with normal `match` syntax.

```voyd
match(drink)
  MaybeDrink::None:
    0
  MaybeDrink::Some { value }:
    value
```

`enum` is implemented as macro-backed sugar over nominal unions, but the surface
syntax above is the stable language feature most users should care about.
