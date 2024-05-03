# Unions

Union types represent a value that can be one of a predefined set of types.

A union type is defined by listing each of the types it may be, separated by the
pipe operator, `|`.

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

In some cases, where the nominal object is only ever used as part of a union,
union sugar can be used

```
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
