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

```
type Point = {
  x: Int,
  y: Int
}

// Immutable object
let p1 = Point { x: 5, y: 4 }
p1.x = 6 // Error: Cannot reassign to immutable field

// Mutable object
let p2 = &Point { x: 5, y: 4 }
p2.x = 6 // p2.x is now 6

// Variables can be mutable while holding an immutable object
var p3 = Point { x: 5, y: 4 }
p3.x = 6 // Error: Cannot reassign to immutable field

p3 = Point { x: 6, y: 4 } // p3 is now a new object
```

When passing a mutable object to a function
