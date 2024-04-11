# Intersections

Void uses intersection types to combine the fields of multiple objects into a
single type.

An intersection type is defined by listing the types it is composed of separated
by `&`.

```
type Vec2D = {
  a: i32,
  b: i32
}

type Vec3D = Vec2D & {
  c: i32
}
```

the type expression of `Vec3D` resolves to:

```
type Vec3D = Object & {
  a: i32,
  b: i32,
  c: i32
}
```

Note that the fields of an intersection cannot conflict:

```
type Vec2D = {
  a: i32,
  b: i32
}

type Vec3D = Vec2D & {
  // Error - Conflicts with intersected field b: i32
  b: string,
  c: i32
}
```

## Intersection Types and Nominal Objects

When an intersection includes a nominal object, the object must be a subtype of
that object.

```
obj Animal {
  name: String
}

type Cat = Animal & {
  lives_remaining: i32
}

let cat: Cat = Animal { name: "Whiskers", lives_remaining: 9 }

// Error - Object { name: "Whiskers", lives_remaining: 9 } is not an Animal
let bad_cat: Cat = { name: "Whiskers", lives_remaining: 9 }
```

All object types of an intersection must be a subtype of the previous
intersected object type, or a parent type of the previous intersected object type.

```
obj Animal {
  name: String
}

obj Cat extends Animal {
  lives_remaining: i32
}

obj Dog extends Animal {
  likes_belly_rubs: bool
}

type Chihuahua =
  Dog & { size: i32 } &
  Animal & { age: i32 } // This is ok since Animal is a parent of Dog

// Resolves to:
type Chihuahua = Dog & {
  name: String,
  likes_belly_rubs: bool,
  age: i32,
  size: i32
}

// Error Dog is not a subtype of Cat
type Abomination = Cat & Dog
```

## Intersection Types and Traits

An intersection type can combine multiple traits to define a type that must
satisfy all of the traits.

```

trait Image
  fn draw(self) -> Array[Rgb]

trait Movable
  fn move(&self, x: i32, y: i32) -> void

type MoveableImage = Movable & Drawable

obj Shape {
  image: Array<Rgb>
  x: i32
  y: i32
}

impl Image for Shape
  fn draw(self) -> Array<Rgb>
    self.image

impl Movable for Shape
  fn move(&self, x: i32, y: i32) -> void
    self.x += x
    self.y += y

let shape: MoveableImage = Shape { image: [Rgb(0, 0, 0)], x: 0, y: 0 }
```
