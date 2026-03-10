---
order: 210
---

# Objects

Voyd has two object-style type families:

- structural object types, written with `type Name = { ... }`
- nominal object types, written with `obj Name { ... }`

## Structural objects

Structural objects are satisfied by shape.

```voyd
type Point = {
  x: i32,
  y: i32
}

fn length_sq(point: Point) -> i32
  point.x * point.x + point.y * point.y

length_sq({ x: 3, y: 4 })
```

Structural object literals support field shorthand and spread.

```voyd
let x = 1
let y = 2
let point = { x, y }
let point3 = { ...point, z: 3 }
```

Optional fields use `?`.

```voyd
obj OptionalBox {
  value?: i32
}
```

## Nominal objects

Nominal objects have their own identity.

```voyd
obj User {
  id: i32,
  name: String
}

let user = User { id: 1, name: "Ada" }
```

Structural compatibility does not satisfy a nominal parameter.

```voyd
fn load(user: User) -> i32
  user.id

// load({ id: 1, name: "Ada" })  // error
```

Nominal values still satisfy compatible structural expectations.

```voyd
fn load_id(value: { id: i32 }) -> i32
  value.id

load_id(user)
```

## Constructors

Nominal objects support constructor-literal syntax and `init` overloads.

```voyd
obj Color {
  x: i32,
  y: i32,
  z: i32
}

impl Color
  fn init(x: i32, y: i32, z: i32) -> Color
    Color { x, y, z }

Color { x: 1, y: 2, z: 3 }
Color(1, 2, 3)
```

Constructors also resolve through aliases that target nominal objects.

```voyd
pub type Vec3Alias = Color

let value = Vec3Alias(1, 2, 3)
```

## Methods

Methods live in `impl` blocks.

```voyd
impl Color
  fn sum(self) -> i32
    self.x + self.y + self.z
```

See [Mutability](../mutability.md) for `~self` and mutable field access.
