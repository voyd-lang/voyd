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

Construct variants through the enum namespace. Parentheses provide fieldwise
construction when the variant does not declare an `init` constructor.

```voyd
let first: MaybeDrink<i32> = MaybeDrink::Some<i32>(value: 10)
let second: MaybeDrink<i32> = MaybeDrink::Some<i32> { value: 10 }
```

Unit variants are also valid, including generic unit variants.

```voyd
pub enum Signal
  Idle
  Ready<T>

let signal: Signal<i32> = Signal::Ready<i32>()
```

Match on enum variants with normal `match` syntax.

```voyd
match(drink)
  MaybeDrink::None:
    0
  MaybeDrink::Some { value }:
    value
```

When a variant name is not otherwise in scope, a match pattern can infer it
from the discriminant's enum members.

```voyd
use src::drinks::{ MaybeDrink }

match(drink)
  None:
    0
  Some { value }:
    value
```

Qualify the pattern when another visible type has the same name or when the
discriminant contains ambiguous instances of the same generic variant.

`enum` is implemented as macro-backed sugar over nominal unions, but the surface
syntax above is the stable language feature most users should care about.
