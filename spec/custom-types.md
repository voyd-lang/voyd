# Types

```
// Object type (curly braces are optional)
obj Point2D { x: Int, y: Int }

// Object type with methods
obj Point2D
  x: Int
  y: Int

  fn toVec() -> Vec2D
    Vec2D[x, y] // self is implicit

// Object extensions
obj Point3D extends Point2D
  x: Int
  y: Int
  z: Int

  fn toVec3() -> Vec3D
    Vec3D[self.x, self.y, self.z]

  // Mutating method
  fn setZ(v: Int) mut -> void
    // self is implicit
    z = v

  // ERROR: overrides must return the same type
  override fn toVec() -> Vec3D
    Vec3D[self.x, self.y, self.z]

// Tuple object
obj Vec2D [Int, Int]

// Tuple object with methods
obj Vec3D
  [Int, Int, Int]

  fn product(self: Self)
    self.0 * self.1 * self.2


// Intersections
// (Types are structural, objects are nominal[1])
type NamedPoint = Point3D & { name: string }

// Union
type Point = NamedPoint | Point3D | Point2D

// Union with inline types
type Optional =
  obj None |
  obj Some [Int]

// Trait (Abstract objects)
trait Animal
  species: string

  fn age() -> Int


  // Default implementation
  fn hey() log -> void
    log("hey")

obj Human extends Animal
  fn age()
    years
```

1. When a value's type is defined as an object, it must be set to that object or an extended version of that object. When a value's type is defined as a type literal or type alias, it must be set to an object or type that satisfies the definition, regardless of type name. Thus objects are nominal, types are structural.
