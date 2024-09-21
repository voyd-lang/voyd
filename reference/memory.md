# Memory

## Value vs Reference Types

- Value types are passed by value. When a variable or parameter is assigned to a value type, they are given a copy of the value.
- Reference types are passed by reference. When a variable or parameter is assigned to a reference type, they are given a reference to the value.

Objects are reference types, and all other types are value types.

## Ownership

Ownership is a set of rules that apply to reference types.

They are as follows:
- An owner refers to the variable or parameter that holds the reference to an instance of a reference type.
- A mutable reference can only have one owner at a time.
- An immutable reference can have any number of owners at a time.
- References can be borrowed from an owner via assignment or function call. The borrow is returned once the new owner goes out of scope.
- A mutable reference can be converted to an immutable reference by assigning it to an immutable reference variable or parameter. When ownership is returned to its original owner, the reference is converted back to a mutable reference.

## Mutability

Normal Usage:

```
// Given an object
obj Vec3 {
  x: i32
  y: i32
  z: i32
}

fn bump_x(v: &Vec3) -> Vec3
  v.x += 1

fn main()
  let mutable = &Vec3 { x: 1, y: 2, z: 3 }
  mutable.bump_x() // OK
  mutable.x = 5 // OK

  // Examples of immutable behavior
  let immutable = Vec3 { x: 1, y: 2, z: 3 }

  // ERROR: Cannot borrow immutable reference as mutable
  immutable.bump_x()
  immutable.x = 5

  // Mutable assignment to a mutable reference is converted to an immutable reference unless explicitly borrowed
  let mutable2 = &Vec3 { x: 1, y: 2, z: 3 }
  let immutable2 = mutable2
  immutable2.x = 5 // ERROR: Cannot borrow immutable reference as mutable
  let mutable3 = &mutable2
  mutable3.x = 5 // OK
  mutable2.x = 5 // ERROR ownership of mutable2 has been transferred to mutable3, mutable2 is now immutable
```

Mutable references can only be made to object types:

```voyd
// Error cannot borrow primitive type as mutable
fn bump(x: &i32) -> i32
  x += 1

fn main()
  var x = 5

  // Ok
  x = 3

  // Error
  bump(&x)
```
