---
order: 260
---

# Intersections

Intersection types require a value to satisfy multiple type requirements at the
same time.

## Structural intersections

```voyd
type HasId = { id: i32 }
type HasName = { name: String }

type UserShape = HasId & HasName
```

The resulting type must satisfy every field requirement.

## Trait intersections

Intersections are also useful for combining traits.

```voyd
trait Draw
  fn draw(self) -> String

trait Move
  fn move(self, by: i32) -> i32

type DrawableMover = Draw & Move
```

## Nominal intersections

The compiler may display some nominal types in fully elaborated form as a
nominal head plus structural fields:

```voyd
Sphere & { center: Vec3, radius: f64 }
```

That is mainly a type-display detail. In source code, you usually construct the
value through the nominal object's normal constructors or object literal syntax.
