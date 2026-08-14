---
order: 270
---

# Traits

Traits describe behavior that nominal types can implement.

## Declaring a trait

```voyd
pub trait Hittable
  fn hit(self, { ray: Ray, ray_tmin: f64, ray_tmax: f64, ~rec: HitRecord }) -> bool
```

## Implementing a trait

```voyd
pub obj Sphere {}

impl Hittable for Sphere
  fn hit(self, { ray: Ray, ray_tmin: f64, ray_tmax: f64, ~rec: HitRecord }) -> bool
    if ray.direction > 0.0 and ray_tmin <= ray_tmax:
      rec.t = 1
      true
    else:
      false
```

## Default methods

Traits may provide default method bodies.

```voyd
trait One
  fn one() -> i32
    1
```

Implementations can keep the default or override it.

## Isolated dynamic calls

Use `@isolated` when every implementation of a trait method must avoid ambient
mutable state, callbacks or other reentrant control, effects, and suspension
for the full call.

```voyd
trait DictKey<K>
  @isolated
  fn dict_hash(self): () -> i32
```

An isolated method must write the explicit empty effect row `: ()`. The
compiler checks a default body and every implementation against the contract,
including implementations compiled in another module. Parameter access remains
part of the normal signature: a plain parameter may be read, while a `~`
parameter may be written.

This contract lets compatible dynamic calls run while an exclusive capability
is live. Calls with overlapping parameter access are still rejected.

## Trait-typed values

Traits are valid type positions for fields and parameters.

```voyd
pub obj World {
  object: Hittable
}
```

## Generic traits

Traits and trait impls can be generic and can carry constraints, just like
functions and objects.
