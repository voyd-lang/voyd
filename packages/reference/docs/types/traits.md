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
