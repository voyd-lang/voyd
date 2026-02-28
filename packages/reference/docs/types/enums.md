---
order: 240
---

# Enum

```voyd
enum Drink
  Coffee { size: Size, sugar: Grams, cream: Grams }
  Tea { size: Size, sugar: Grams, cream: Grams }
  Soda { size: Size }
  Water

let drink: Drink = Drink::Soda { size: Medium() }
```

Internally, enums are syntactic sugar for unions:
```voyd
enum Drink
  Coffee { size: Size, sugar: Grams, cream: Grams }
  Tea { size: Size, sugar: Grams, cream: Grams }
  Soda { size: Size }
  Water

// Resolves to:
type Drink =
  (obj Coffee { size: Size, sugar: Grams, cream: Grams }) |
  (obj Tea { size: Size, sugar: Grams, cream: Grams }) |
  (obj Soda { size: Size }) |
  (obj Water) |
  ```
```
