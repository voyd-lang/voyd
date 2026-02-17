# Generics

Generic parameters let APIs abstract over types:

```voyd
fn id<T>(value: T) -> T
  value
```

Generics are supported on declaration type parameter lists:

- functions
- type aliases
- objects
- traits
- impl blocks
- effects

## Constrained Generics

Use `T: <type-expr>` to restrict which types can be used for a parameter:

```voyd
fn add<T: Numeric>(a: T, b: T) -> T
  a + b
```

Constraint checks run when type arguments are applied (inferred or explicit).
If the type argument does not satisfy the constraint, compilation fails.

## Constraint Kinds

### Trait Constraints

Require that a type implements a trait:

```voyd
trait Run
  fn run(self) -> i32

fn use_runner<T: Run>(value: T) -> i32
  value.run()
```

### Structural Constraints

Require a structural shape:

```voyd
fn get_value<T: { value: i32 }>(item: T) -> i32
  item.value
```

### Nominal Subtype Constraints

Require nominal compatibility:

```voyd
obj Animal {
  id: i32
}

fn take_animal<T: Animal>(value: T) -> i32
  value.id
```

Structural lookalikes do not satisfy nominal constraints unless they are
instances of a compatible nominal object type.

## Combining Constraints

Use intersections to express multiple requirements:

```voyd
fn render<T: Drawable & { id: i32 }>(value: T) -> i32
  value.id
```

This means `T` must satisfy every member of the intersection.

## Constrained Declarations

Constraints work on non-function declarations too:

```voyd
type Wrap<T: { value: i32 }> = T

obj Box<T: Animal> {
  value: T
}

trait Repository<T: Serializable>
  fn save(self, value: T) -> i32

impl<T: Animal> Box<T>
  fn get(self) -> T
    self.value

eff Stream<T: Payload>
  fn next() -> T
```
