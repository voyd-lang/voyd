# Types

## Object Types

```
// Object type with methods
obj Point2D =
  x: Int
  y: Int

  fn toTuple() -> [Int, Int]
    [self.x, self.y]

// Object extensions
obj Point3D extends Point2D =
  x: Int
  y: Int
  z: Int

  fn toTuple3() -> [Int, Int, Int] =
    [x, y, z] // Self is implicit

  // Mutating method
  fn setZ(v: Int) mut -> void =
    z = v

  // ERROR: overrides must return the same type as their parent
  override fn toTuple() -> [Int, Int, Int] =
  [self.x, self.y, self.z]

// Intersections
// (Types are structural, objects are nominal[1])
type NamedPoint = Point3D & { name: string }

// In a Union
type Point = NamedPoint | Point3D | Point2D

// Trait (Abstract objects)
trait Animal =
  species: string

  fn age() -> Int

  // Default implementation
  fn hey() log -> void
    log("hey")

obj Human extends Animal =
  fn age()
    years
```

## Case Types

Case types define a situation. They serve a similar purpose to enums. They can be very useful
as return values when a function may return more than one type of result. Cases may also hold
an associated value.

```
type Optional<T> =
  case Some(T) |
  case None

type Result =
  case Ok |
  case Error(String)

// Possible sugar
enum Result = Ok, Error(String)
```

1. When a value's type is defined as an object, it must be set to that object or an extended version of that object. When a value's type is defined as a type literal or type alias, it must be set to an object or type that satisfies the definition, regardless of type name. Thus objects are nominal, types are structural.
