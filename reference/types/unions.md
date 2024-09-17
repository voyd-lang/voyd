# Unions

Union types represent a value that can be one of a predefined set of types.

A union type is defined by listing each of the types it may be, separated by the
pipe operator, `|`.

```void
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

In some cases, where the nominal object is only ever used as part of a union,
union sugar can be used

```void
union Drink
  Coffee { size: Size, sugar: Grams, cream: Grams }
  Tea { size: Size, sugar: Grams, cream: Grams }
  Soda { size: Size }
  Water

let drink: Drink = Drink::Soda { size: Medium() }

// Resolves to:
type Drink =
  (obj Coffee { size: Size, sugar: Grams, cream: Grams }) |
  (obj Tea { size: Size, sugar: Grams, cream: Grams }) |
  (obj Soda { size: Size }) |
  (obj Water) |
```

## Calling Methods Of A Union Type

If all objects of a union have a method with the same signature
(other than self (mutability excluded)). That method can be called
directly from the union

```void
type Animal = Cat | Dog

obj Cat {}
obj Dog {}

impl Cat
  pub fn speak(self)
    self.meow()

  pub fn meow(self)
    log "Meow"

impl Dog
  pub fn speak(self)
    self.meow()

  pub fn woof(self)
    log "Woof"

fn main()
  let animal = Animal(Dog {})
  animal.speak() // Woof!
  animal.woof() // Error
```

Internally, the method call is expanded to a match statement.
