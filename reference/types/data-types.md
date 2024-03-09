# Types Overview

Data types come in two flavors: value and reference.

The type system is structural at its core and supports nominal types through the use of objects and traits.

## Value Types

Value types are copied when passed to a function or assigned to a variable.

They include:
- `i32`
- `i64`
- `f32`
- `f64`
- `v128`
- `bool`
- `void`

## Reference Types

Reference types are heap allocated, passed by reference, can be mutable, and can be extends. All reference types extend the top level `Object` type.

# Tuples

Tuples are a fixed sequence of values of different types.


```
type MyTuple = [i32, String, bool]
let my_tuple: MyTuple = [1, "hello", true]

let x = my_tuple.0
let y = my_tuple.1
let z = my_tuple.2

// Tuples can also be destructured
let [a, b, c] = my_tuple
```

# Objects

Objects are extensible data types that can be used to represent complex user defined data structures.

They have a few key features:
- They are passed by reference
- They can be extended
- They maintain type information at runtime

All objects extend the top level `Object` type.

`Strings`, `Arrays`, `Tuples`, and `Dictionaries` are all `Object` types.

```
record Ab extends Record has {
	a: i32
	b: i32
}
```


## Structural Objects

Structural objects are defined by their structure. That is, any object that contains the same fields as the type you're defining is considered to be of that type.

```
type MyObject = {
	a: i32,
	b: i32
}

let my_object: MyObject = {
	a: 5,
	b: 4
}
```

Field shorthand:

```
let a = 5
let value = { a, b: 4 }
```

Spread operator:

```
let a = 5
let value = { a, b: 4 }
let value2 = { ...value, c: 3 }
```

## Nominal Objects

Nominal objects are structural objects with a few extra features. They can be extended, have methods, and implement traits.

```
obj Animal
	name: String

// Note that extensions must include all fields of the type being extended
obj Cat extends Animal
	name: String
	lives_remaining: i32

obj Dog extends Animal
	name: String
	likes_belly_rubs: bool

let me = Animal { name: "John" }
```

While a nominal object can satisfy a structural type with the same fields, the reverse is not true. A nominal object can only be used where the type it extends is expected.

```
fn pet(animal: Animal) -> void
	// ...

pet(Cat { name: "Whiskers", lives_remaining: 9 })
pet(Dog { name: "Spot", likes_belly_rubs: true })

// Error - pet expects an Animal, not a { name: String, lives_remaining: i32 }
pet({ name: "Whiskers", lives_remaining: 9 })

fn pet_structural(animal: { name: String }) -> void
	// ...

// Ok!
pet_structural({ name: "Whiskers" })

// Ok!
pet_structural(Cat { name: "Whiskers", lives_remaining: 9 })
```

Methods can be defined on nominal objects using the `impl` keyword.

```
obj Animal
	name: String

impl Animal
	fn run(self) -> String
		"${self.name} is running!"

	fn change_name(mut self, name: String) -> void
		self.name = name

let me = Animal { name: "John" }
log(me.run()) // "John is running!"

// The & prefix must be used to call methods that mutate the object
&me.change_name("Bob")
```

### Nominal Object Initializers

Nominal objects have a default initializer that takes the fields of the object as arguments.

```
obj Animal {
	id: i32
	name: String
}

let me = Animal { name: "John", id: 1 }
```

You can add a custom initializer by defining a function with the same name as the object that accepts different arguments.

```
obj Animal {
	id: i32
	name: String
}

fn Animal({ name: String }) -> Animal
	Animal { id: genId(), name }
```

## Traits

Traits are first class types that define the behavior of a nominal object.

```
trait Runnable
	fn run(self) -> String
	fn stop(mut self) -> void

obj Car
	speed: i32

impl Runnable for Car
	fn run(self) -> String
		"Vroom!"

	fn stop(mut self) -> void
		self.speed = 0

let car = Car { speed: 10 }
log(car.run()) // "Vroom!"
&car.stop()

car is Runnable // true

fn run_thing(thing: Runnable) -> void
	log(thing.run())
```

# Unions

Union types represent a value that can be one of a predefined set of types.

A union type is defined by listing each of the types it may be, separated by the pipe operator, `|`.

```
type Animal = Cat | Dog

obj Cat {
	age: i32
	name: String
}

obj Dog {
	age: i32
	name: String
}
```

# Intersection Types

Intersection types combine the fields of object types into a single type.

An intersection type is defined by listing the types it is composed of separated by `&`.

```
type Name = { name: String }
type Age = { age: i32 }
type Person = Name & Age & { id: i32 }

let person: Person = { name: "John", age: 25, id: 1 }
```

## Intersection Types and Nominal Objects

When a nominal object is intersected, only types that extend the nominal object can satisfy the intersection. All nominal objects included must be
a subtype of the previous nominal object included in the intersection.

```
obj Name
	name: String

type NameAndAge = Name & { age: i32 }

obj Person extends Name
	age: i32
	id: i32

// Ok!
let person: NameAndAge = Person { name: "John", age: 25, id: 1 }

// Error - NameAndAge expects a Name & { age: i32 }
let person2: NameAndAge = { name: "John", age: 25 }
```

## Intersection Types and Traits

An intersection type can combine multiple traits to define a type that must satisfy all of the traits.

```

trait Image
	fn draw(self) -> Array[Rgb]

trait Movable
	fn move(&self, x: i32, y: i32) -> void

type MoveableImage = Movable & Drawable

obj Shape
	image: Array[Rgb]
	x: i32
	y: i32

impl Image for Shape
	fn draw(self) -> Array[Rgb]
		self.image

impl Movable for Shape
	fn move(&self, x: i32, y: i32) -> void
		self.x += x
		self.y += y

let shape: MoveableImage = Shape { image: [Rgb(0, 0, 0)], x: 0, y: 0 }
```

# Built in Object Types

## Strings

Strings are a sequence of characters. The main string type, `String`, is can grow and shrink in size when defined as a mutable variable.

Type: `String`

```
let my_string = String()

// String literals are of type `String`
let my_string2 = "Hello, world!"
```

## Arrays

Arrays are a growable sequence of values of the same type.

Type: `Array`

```
let my_array = Array(1, 2, 3)
```

## Dictionaries

Dictionaries are a growable collection of key-value pairs.

Type: `Dictionary`

```
let my_dict = Dict { a: 1, b: 2, c: 3 }
```
