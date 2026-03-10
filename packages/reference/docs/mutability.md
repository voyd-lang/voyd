---
order: 80
---

# Mutability

Voyd separates binding mutability from object mutation.

## Reassignable bindings

Use `var` when the binding itself must be reassigned.

```voyd
var count = 0
count = count + 1
```

`let` bindings are immutable.

```voyd
let count = 0
// count = 1  // error
```

## Mutable object access

Use `~` when a binding or parameter must support field mutation.

```voyd
obj Point {
  x: i32,
  y: i32
}

let ~point = Point { x: 1, y: 2 }
point.x = 3
```

Methods and functions must also request mutable access explicitly.

```voyd
impl Point
  fn move_x(~self, dx: i32) -> void
    self.x = self.x + dx

fn reset_x(~point: Point) -> void
  point.x = 0
```

Without `~`, field mutation is rejected even if the type itself has mutable
fields.

## Module scope

Module-level `let` declarations are allowed, including `pub let`.

```voyd
let answer = 41
pub let version = "0.1"
```

Mutable object-binding syntax is local-only. Module-level `let ~value = ...` is
not supported.
