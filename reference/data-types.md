# Strings

Strings are a sequence of characters. The main string type, `String`, is can grow and shrink in size when defined as a mutable variable.

Type: `String`

```
let my_string = String()

// String literals are of type `String`
let my_string2 = "Hello, world!"
```

# Atoms

Atoms are literals who's type and value are equivalent to their given name. They are useful for defining a set of unique values.

```
let my_atom: @my_atom = @my_atom
let my_atom2 = @my_atom
let other_atom = @other_atom

my_atom == my_atom2 // true
my_atom == other_atom // false
```

Atoms with spaces in their can be defined using the `@` prefix and single quotes.

```
let my_atom = @'my atom'
```

Atoms may also contain associated data.

```
type Tag = @tag(String)
let my_tag = @tag("hello")
```

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

# Arrays

Arrays are a growable sequence of values of the same type.

Type: `Array`

```
let my_array = Array<i32>()
```

# Objects

Objects are a collection of key-value pairs. They can be either structural,
or nominal.

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

Unions represent a type that can be one of a set of other types.

A union type is defined by listing the types it can be separated by `|`.

```
obj Cat
	age: i32
	name: String

obj Dog
	age: i32
	name: String

type Animal = Cat | Dog

// Can be used with atoms
type MyResult = @ok | @error
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

When a nominal object is intersected, only types that extend the nominal object can satisfy the intersection. Only one nominal object can be included in an intersection.

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

# Enums / Algebraic Data Types

In void, enums are implemented using a combination of unions and atoms.

```
type Result = @ok(i32) | @error(String)

fn divide(a: i32, b: i32) -> Result
	if b == 0
		@error("Cannot divide by zero")
	else
		@ok(a / b)

if let @ok(result) = divide(10, 2)
	log(result)
else
	log("Error")
```
