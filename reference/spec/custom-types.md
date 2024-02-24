# Types

## Objects

```
obj Animal
  name: String

let me = Animal { name: "John" }
```

## Object Extensions

```
// Objects open to extension must be marked with the open keyword
open-obj Animal is
  name: String

obj Cat extends Animal
  name: String
  lives_remaining: Int

obj Dog extends Animal
  name: String
  likes_belly_rubs: Bool
```

## Methods

```
obj Animal
  name: String

impl Animal
  fn run() -> String
    "I'm running!"
```

## Structural Typing

Structural typing allows you to define a type by its structure. That is, any type that contains the
same fields and methods as the type you're defining is considered to be of that type.

```
type NamedThing = { name: String }

// Anything that contains a name field is considered to be of type NamedThing
let me = { name: "John" } // Untyped object literal
let dog = Animal { name: "Spot" }

fn print_name(thing: NamedThing) log -> void
  log(thing.name)

print_name(me) // "John"
print_name(dog) // "Spot"
```

## UFCS

With UFCS, any function that takes an object as its first argument can be called as a method on that object.

```
fn meow(cat: Cat) -> String
  "Meow, my name is " + cat.name

let cat = Cat { name: "Fluffy", lives_remaining: 9 }
cat.meow() // "Meow, my name is Fluffy"
```

## Traits

Traits define the behavior of an object. That is, a group of methods associated with an object. They
work similarly to traits in rust, except they can extend other traits.

If you're unfamiliar with rust, traits are like interfaces in other languages. The main difference
is they can only define the methods of an object and not the fields.

```
trait Animal
	fn age() -> Int

  // Default implementation
  fn hey() log -> void
    log("hey")

obj Human
	years: Int

impl Animal for Human
	fn age() = years
```

## Trait Extensions

```
trait Animal
	fn age() -> Int

	// Default implementation
	fn hey() log -> void
		log("hey")


trait Mammal extends Animal
	fn age() -> Int
	fn isAquatic() -> Boolean
	// Default implementation is inherited
	fn hey() log -> void

```

## Fully Qualified Call Syntax

Resolves the correct method when the selection is ambiguous to the compiler

```
trait Render
	fn draw() -> Int = ()

trait Cowboy
	fn draw() -> Int = ()


obj Person

impl Render for Person
impl Cowboy for Person

const me = Person()
Cowboy::draw(me)
Render::draw(me)
```

### Default function implementations

Things to consider:

-   http://developear.com/blog/2017/02/26/swift-protocols.html

## Inspiration

### Integrating Nominal and Structural Subtyping

URL:
https://www.cs.cmu.edu/~aldrich/papers/ecoop08.pdf

### Traits: Composable Units of Behavior

URL:
https://www.cs.cmu.edu/~aldrich/courses/819/Scha03aTraits.pdf

Notes:

I think with safe mutations from algebraic effects, we can get rid of the limitation within traits
that prevents them from referencing mutable state (i.e. having field constraints).
https://dl.acm.org/doi/pdf/10.1145/3471874.3472988
