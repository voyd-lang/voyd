# Types

## Object Types

```
// Object type with methods
obj Point2D
  x: Int
  y: Int

impl Point2D
  fn toTuple() -> [Int, Int]
    [self.x, self.y]

// Object extensions
obj Point3D extends Point2D
  x: Int
  y: Int
  z: Int

impl Point3D
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

// Trait
trait Animal
  fn age() -> Int

  // Default implementation
  fn hey() log -> void =
    log("hey")

obj Human
  years: Int

impl Animal for Human
  fn age() =
    years
```

1. When a value's type is defined as an object, it must be set to that object or an extended version of that object. When a value's type is defined as a type literal or type alias, it must be set to an object or type that satisfies the definition, regardless of type name. Thus objects are nominal, types are structural.

```
trait Syntax
  syntax_id = getSyntaxId()
  syntax_type: string
  location?: SourceLocation
  lexicon: LexicalContext


obj List: Syntax {
  syntax_id = getSyntaxId()
  syntax_type: string
  location?: SourceLocation
  lexicon: LexicalContext
}

```
