# Objects

Objects are a reference data type that represent a fixed collection of key value
pairs (fields).

They are defined by listing their fields between curly braces `{}`.

```
type MyObject = {
  a: i32,
  b: i32
}
```

# Initializing an Object

An object is initialized using object literal syntax. Listing the fields and
their corresponding values between curly braces `{}`.

```
let my_object: MyObject = {
  a: 5,
  b: 4
}
```

Field shorthand:

```void
// When a variable has the same name as a field;
let a = 5
// The field can be omitted
let value = { a, b: 4 }
```

Spread operator:

```void
type MyObject2 = {
  a: i32,
  b: i32,
  c: i32
}

let a = 5
let value = { a, b: 4 }
let value2: MyObject2 = { ...value, c: 3 }
```

# Nominal Objects

The objects we have defined so far were all structural types. That is, they were
satisfied by any object that had the same fields:

```void
type Animal = {
  name: string
}

fn print_animal_name(animal: Animal) -> void
  log(animal.name)

square_area({ name: "Spot" }) // Ok!
square_area({ name: "Spot", species: "Dog" }) // Also Ok!
```

Sometimes, it may be desirable to define a type that is only satisfied by a type
explicitly defined to satisfy it. This is called a nominal type.

For example:

```void
type BaseballPlayer = {
  has_bat: bool
}

type Cave = {
  has_bat: bool
}

fn can_hit_ball(player: BaseballPlayer) -> bool
  player.has_bat

let ruth: BaseballPlayer = { has_bat: true }
let bat_cave: Cave = { has_bat: true }

can_hit_ball(ruth) // true
can_hit_ball(bat_cave) // true
```

In this example, because `BaseballPlayer` and `Cave` both have a `has_bat`
field, the `can_hit_ball` function can accept both types. So
`can_hit_ball(bat_cave)` returned true, even though it doesn't make sense for a
cave to hit a ball.

to alleviate this, we can define a nominal subtype of `Object`:

```void
obj BaseballPlayer {
  has_bat: bool
}

type Cave = {
  has_bat: bool
}

fn can_hit_ball(player: BaseballPlayer) -> bool
  player.has_bat

let ruth = BaseballPlayer { has_bat: true }
let bat_cave: Cave = { has_bat: true }

can_hit_ball(ruth) // true
can_hit_ball(bat_cave) // Error - bat_cave is not a BaseballPlayer
```

While a nominal object can satisfy a structural type with the same fields, the
reverse is not true. A nominal object can only be used where the type it extends
is expected.

```void
obj Animal {
  name: String
}

obj Cat extends Animal {
  lives_remaining: i32
}

obj Dog extends Animal {
  likes_belly_rubs: bool
}

fn pet(animal: Animal) -> void
  // ...

pet(Cat { name: "Whiskers", lives_remaining: 9 }) // Ok!
pet(Dog { name: "Spot", likes_belly_rubs: true }) // Ok!

// Error - pet expects an Animal, not a { name: String, lives_remaining: i32 }
pet({ name: "Whiskers", lives_remaining: 9 })

fn pet_structural(animal: { name: String }) -> void
  // ...

// Ok!
pet_structural({ name: "Whiskers" })

// Ok!
pet_structural(Cat { name: "Whiskers", lives_remaining: 9 })
```


## Nominal Object Initializers

Nominal objects have a default initializer that takes the fields of the object
as arguments.

```void
obj Animal {
  id: i32
  name: String
}

let me = Animal { name: "John", id: 1 }
```

You can add a custom initializer by defining a function with the same name as
the object that accepts different arguments.

```void
obj Animal {
  id: i32
  name: String
}

fn Animal({ name: String }) -> Animal
  Animal { id: genId(), name }
```

## Methods

Methods can be defined on nominal objects using the `impl` keyword.

```void
obj Animal {
  name: String
}

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

## Final Objects

Objects can be defined as final, meaning they cannot be extended.

```void
final obj Animal {
  name: String
}

// Error - Animal is final
obj Cat extends Animal {
  lives_remaining: i32
}
```

## Object Type Narrowing

```void
obj Optional

obj None extends Optional

obj Some extends Optional {
  value: i32
}

fn divide(a: i32, b: i32) -> Optional
  if b == 0
    None { }
  else:
    Some { value: a / b }

fn main(a: i32, b: i32)
  a.divide(b)
    .match(x)
      Some:
        log "The value is ${x}"
      None:
        log "Error: divide by zero"
```

# Traits

Traits are first class types that define the behavior of a nominal object.

```
trait Runnable
  fn run(self) -> String
  fn stop(mut self) -> void

obj Car {
  speed: i32
}

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

# Built in Object Types

## Strings

Strings are a sequence of characters. The main string type, `String`, is can
grow and shrink in size when defined as a mutable variable.

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
