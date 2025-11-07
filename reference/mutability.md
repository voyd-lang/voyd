# Mutability In Voyd

## Variable Mutability

Variable mutability determines if a variable can be **reassigned** or not.

```
// Immutable variable
let x = 5
x = 6 // Error: Cannot reassign to immutable variable

// Mutable variable
var y = 3
y = 4 // y is now 4
```

## Object Mutability

Object mutability determines if the **fields** of an object can be **reassigned**
or not.

Note that variable mutability is different from object mutability. A mutable
variable can still hold an immutable object and vice versa.

```voyd
obj Point {
  x: i32,
  y: i32
}

// Immutable object
let p1 = Point { x: 5, y: 4 }
p1.x = 6 // Error: Cannot reassign to immutable field

// Mutable object
let &p2 = Point { x: 5, y: 4 }
p2.x = 6 // p2.x is now 6

// Variables can be mutable while holding an immutable object
var p3 = Point { x: 5, y: 4 }
p3.x = 6 // Error: Cannot reassign to immutable field

p3 = Point { x: 6, y: 4 } // p3 is now a new object

// Parameters and methods must also mark themselves as mutable references
impl Point
  fn unbump(&self) -> voyd
    self.x = self.x - 1

fn bump(&v: Point) -> voyd
  v.x = v.x + 1

fn bump_bad(v: Point) -> voyd
  v.x = v.x + 1 // This will throw an error, it doesn't borrow a mutable Point

pub fn main() -> i32
  let &a = VecTest { x: 1 }
  let b = VecTest { x: 1 }
  bump(a) // Ok
  bump(b) // Error - b is not mutable
```
