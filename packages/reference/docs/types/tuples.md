---
order: 230
---

# Tuples

Tuples are fixed-size ordered values.

```voyd
type Pair = (i32, String)

let pair: Pair = (1, "two")
let first = pair.0
let second = pair.1
```

Tuples support destructuring.

```voyd
let (x, y) = pair
```

Tuple patterns also work inside `match`.

```voyd
match(pair)
  (id, name):
    id
```
