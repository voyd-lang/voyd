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
  var mutable = Vec3 { x: 1, y: 2, z: 3 }

  // Mutable references must be explicitly borrowed with the & operator
  bump_x(&mutable)

  // & operator must be used even when using methods
  &mutable.bump_x()
  &mutable.x = 5

  // Examples of immutable behavior
  let immutable = Vec3 { x: 1, y: 2, z: 3 }

  // ERROR: Cannot borrow immutable reference as mutable
  &immutable.bump_x()
  &immutable.x = 5
```

Mutable references can only be made to object types:

```void
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
