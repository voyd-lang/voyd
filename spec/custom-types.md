# Types

## Class

- Defines a template for an object
- Represent a "heap" type
- Can be recursive
- Can hold structs
- Traits are abstract classes
- A class that implements a trait may be passed to a parameter who's set to that trait

```
class Point2D = {
	x: i32,
	y: i32
}

// Shorthand for single types (no union or intersection)
class Point2D
  x: i32
  y: i32

class Point3D = Point2D & { z: i32 }

// Alternative syntax
class Point3D extends Point2D
  z: i32


class Line<T> = {
  a: T
  b: T
}

class Line2D = Line<Point2D>
class Line3D = Line<Point3D>

class GraphItem = Line2D | Line3D | Point2D | Point3D

class Shape =
  Circle { radius: i32 } |
  Square { radius: i32 }

// Custom Array Type Definition
class MyIntArray
  [key: i32]: i32
```

## Structs

- Are essentially just tuples with labels
- Represent a "stack" type
- Cannot mix with class types
- Cannot be recursive
- Cannot be referenced - may be box-able in the future
- Are always copied
- Compiler may optimize an object
- Note: Tuples are struct types
- A struct can implement a trait, but can not be passed as a parameter who's type is set to that trait

```
struct Point2D = [x: i32, y: i32]

struct Point3D = Point2D & [z: i32]

struct Line<T> = [a: T, b: T]

struct Line2D = Line<Point2D>
struct Line3D = Line<Point3D>

struct GraphItem = Line2D | Line3D | Point2D | Point3D

struct Shape =
  Circle [radius: i32] |
  Square [height: i32, length: i32]

// Struct literal syntax
fn make_struct(a: i32, b: i32) -> [x: i32, y: i32]
  // Note the labels x and y are simply aliases for 0 and 1 respectively. They do not
  // need to be supplied on initialization
	[a, b]
```

## Types

- The type keyword defines a type alias
- Cannot mix stack and heap types
- Class and struct definitions desugar to type expressions

```
type Heap2DPoint = { x:i32, y: i32 }
type Stack2DPoint = [x:i32, y: i32]

type Heap3DPoint = Heap2DPoint & { z: i32 }
type Stack3DPoint = Stack2DPoint & [z:i32]
type Invalid3DPoint = Heap3DPoint & [z:i32] // ERROR: Cannot mix stack and heap types

class Point2D
  x: i32
  y: i32

// De-sugars to
type Point2D = Point2D { x: i32, y: i32 }

class GraphItem = Line2D | Line3D | Point2D | Point3D

// De-sugars to
type GraphItem = Line2D | Line3D | Point2D | Point3D

// Structs de-sugar in the same way

// Note: All types must be tagged
// This expression is sugar for
type Heap2DPoint = { x: i32, y: i32 }
// This
type Heap2DPoint = Heap2DPoint { x: i32, y: i32 }
```
