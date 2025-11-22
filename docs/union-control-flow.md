

```voyd
obj None {}
obj Box<T> { v: T }

type RecType = Box<RecType> | Box<f64> | Box<i32> | None

fn to_int(r: RecType) -> i32
  r.match()
    Box<RecType>: to_int(r.v)
    Box<i32>: 1
    Box<f64>: 2
    None: 3

pub fn main() -> i32
  let a: RecType = Box { v: Box { v: 1 }}
  let b: RecType = Box { v: 2 }
  let c: RecType = Box { v: 3.0 }
  let d: RecType = None {}
  a.to_int() + b.to_int() + c.to_int() + d.to_int()
```
