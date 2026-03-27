# Value Types

Status: Proposed
Owner: Language + Compiler Working Group
Scope: parser surface, semantics/type arena, optimizer, codegen, stdlib container specialization

## Goal

Add first-class value types for small fixed-layout data that should behave like values
instead of heap objects. This gives Voyd a predictable performance escape hatch for
numerics, geometry, and other hot-path aggregates without changing the ergonomic default
object model.

## Motivation

Today most user-defined types are heap objects. That is a good default for expressiveness,
but it is expensive for workloads that create large numbers of short-lived aggregates
such as `Vec3`, `Ray`, `Interval`, and similar math-heavy helper types.

The current `vtrace` benchmark is a representative example:

- small aggregate construction dominates the hot path
- trait dispatch appears on recursive shading edges
- effectful RNG already adds dynamic overhead, so aggregate allocation becomes even more visible

Voyd should keep `obj` as the ergonomic, heap-backed default. It should also provide a
deliberate, more constrained type family for code that wants value semantics and lower
runtime overhead.

## Non-goals

- Replacing `obj` as the default user-defined type.
- Making value types participate in identity-based object features.
- Supporting trait objects backed directly by value types in the MVP.
- Solving every performance problem with a single surface feature. Value types should
  complement optimizer work such as escape analysis and scalar replacement.
- Designing structural value types in the MVP. Existing notes mention `%{}` for future
  structural value literals; this proposal focuses on nominal value declarations first.

## Surface Syntax

Introduce a new top-level declaration form:

```voyd
pub value Vec3 {
  x: f64,
  y: f64,
  z: f64
}
```

`value` is nominal, like `obj`, but uses value semantics.

Initial rules:

- `value` fields must have statically known layout.
- A `value` may contain:
  - primitive scalars
  - other value types
  - tuples of value-compatible fields
  - fixed arrays of value-compatible fields
  - references to heap/object types when explicitly desired
- A `value` may not be recursive in the MVP.
- A `value` has no implicit runtime RTT/method-table payload.

## Core Semantics

### Copy semantics

Value types are copied on:

- assignment
- argument passing to plain parameters
- return from functions
- capture into closures/effect environments unless borrowed

Example:

```voyd
pub value Ray {
  origin: Vec3,
  direction: Vec3
}

fn moved(ray: Ray) -> Ray
  ray

fn demo()
  let a = Ray(Vec3(0.0, 0.0, 0.0), Vec3(1.0, 0.0, 0.0))
  let b = a
  // `a` and `b` are independent copies
```

### Mutation and borrowing

Mutation still requires an addressable mutable location via `~self` or `~param`.

```voyd
pub value Vec3 {
  x: f64,
  y: f64,
  z: f64
}

impl Vec3
  fn '+='(~self, other: Vec3) -> Vec3
    self.x = self.x + other.x
    self.y = self.y + other.y
    self.z = self.z + other.z
    self
```

Semantics:

- `self` means by-value copy.
- `~self` means a mutable borrow of an existing storage location.
- Calling a `~self` method on a temporary is not allowed.

### Identity

Value types do not have observable identity.

That means:

- no identity-based equality or aliasing guarantees
- no self-referential cycles in the MVP
- no assumption that two equal values share storage

### Pattern matching and field access

Field access works the same as for `obj`.

Pattern matching treats values as ordinary nominal constructors, but matching does not
imply heap identity or reference sharing.

## Examples

### Example 1: `Vec3`

```voyd
pub value Vec3 {
  x: f64,
  y: f64,
  z: f64
}

impl Vec3
  fn init(x: f64, y: f64, z: f64) -> Vec3
    Vec3 { x, y, z }

  fn '+'(self, other: Vec3) -> Vec3
    Vec3 {
      x: self.x + other.x,
      y: self.y + other.y,
      z: self.z + other.z
    }

  fn dot(self, other: Vec3) -> f64
    self.x * other.x + self.y * other.y + self.z * other.z
```

This is the canonical use case: small, fixed-layout, copyable math data.

### Example 2: mutable accumulator

```voyd
fn accumulate(~sum: Vec3, sample: Vec3)
  sum += sample
```

This keeps mutation explicit while still letting `Vec3` stay a value type.

### Example 3: mixing values and heap objects

```voyd
pub obj Camera {
  center: Vec3,
  pixel_delta_u: Vec3,
  pixel_delta_v: Vec3
}
```

Heap objects may contain value fields. The object has identity; the embedded values do not.

## Traits

### Allowed: static trait use

Value types may implement traits.

```voyd
pub trait Dot<T>
  fn dot(self, other: T) -> f64

impl Dot<Vec3> for Vec3
  fn dot(self, other: Vec3) -> f64
    self.x * other.x + self.y * other.y + self.z * other.z

fn project<T: Dot<T>>(left: T, right: T) -> f64
  left.dot(right)
```

This is the preferred trait story for values:

- generic constraints
- static dispatch
- monomorphization/specialization

### Disallowed in MVP: implicit trait-object widening

Value types do not implicitly become trait objects.

This should be rejected in the MVP:

```voyd
fn draw(shape: Drawable)
  shape.draw()
```

when `Drawable` is satisfied by a value type argument.

Why:

- trait objects in the current runtime model are reference/existential values
- value types are intended to stay unboxed when possible
- implicit widening would silently reintroduce allocation and dynamic dispatch

### Explicit boxing

If a value must cross a trait-object boundary, that should be explicit. The exact surface
syntax is left open, but the semantics should look like one of these:

- wrap the value in an `obj` adapter
- box the value into a dedicated heap container
- call an explicit `as_dyn(...)`/`boxed(...)` conversion

That keeps the performance cliff visible in the source.

### Trait methods with `~self`

Traits may declare `~self` receivers for value types, but dispatch remains static in the MVP.

This means:

- `impl Trait for MyValue` is allowed
- `MyValue` may satisfy generic trait bounds
- `Trait` existential values should remain heap/reference-only unless explicitly boxed

## Generics and Containers

Value types should be valid generic arguments.

However, layout strategy depends on the container:

- `FixedArray<T>` should store value elements inline when `T` is a value type.
- `Array<T>` should store value elements inline in the MVP, including through its `FixedArray<T>` backing storage and reallocation paths.
- Long term, stdlib containers should specialize layout for value elements where profitable.

This proposal does not require inline-value specialization for every container on day one,
but the type system should not block that evolution.

## Lowering Model

Semantics should model value types separately from nominal heap objects.

Required compiler consequences:

- add a distinct `value-object` descriptor in the type arena
- preserve exact value type ids through optimization IR
- keep value types out of trait-object/runtime-RTT lowering unless explicitly boxed

Codegen should prefer:

- plain Wasm locals for scalar fields
- multi-value params/results where practical, using direct multi-value lowering for aggregates up to 4 ABI lanes
- stack-like temporary storage for larger aggregates, spilling lanes once a value exceeds the 4-lane threshold
- materializing a heap object only when code explicitly requests boxing or when a value
  escapes to a heap/reference context

## Interaction with Optimization Passes

Value types do not replace optimizer work. They reduce the amount of semantic recovery the
optimizer must do later.

The intended relationship is:

1. value types provide an explicit low-overhead source-level model
2. escape analysis and scalar replacement still optimize heap-style code that could have
   been values but was written with `obj`
3. exact-target and devirtualization passes work on generic trait-constrained value code
   without forcing trait-object lowering

## Diagnostics

Diagnostics should make the model obvious:

- error when a value type recursively contains itself
- error when a value type is widened implicitly to a trait object
- error when `~self` is used on a temporary value
- note when a generic/container position forces boxing of a value type in the current backend

## Migration Guidance

Good candidates for `value`:

- vectors, points, rays, colors, intervals
- small geometry records
- numeric helper types
- small immutable or borrow-mutated structs with no identity

Poor candidates for `value`:

- graphs, trees, or recursive shapes
- capability/handle wrappers that rely on identity
- large mutable aggregates routinely shared across modules
- types primarily consumed via trait objects

## Open Questions

- Do we want structural value types (`%{}`) after nominal `value` lands? - NO
- Should `Array<T>` inline value elements in the MVP or in a follow-up? - YES, in MVP
- What size threshold should trigger stack-slot aggregation vs. multi-value lowering? - Use direct multi-value lowering through 4 ABI lanes, then spill to stack-like temporaries.
- Do we want an explicit source-level boxing syntax, and if so what should it be? - Not for MVP.
- Should unions/optionals with value payloads use dedicated inline layouts in the MVP? - YES.
