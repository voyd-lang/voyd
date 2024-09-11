
Context:
```void
obj A {
  x: i32
}

// b is any subtype of A that also has the field y: i32
fn sum(b: A & { y: i32 }) -> i32
  // Field x can be directly accessed via wasm struct.get, as we know b is a supertype of a and a contains x
  b.x +

  // Field y cannot be directly accessed because we do not know the supertype of b that defines y field
  b.y

obj B extends A {
  y: i32
}

fn main() -> i32
  let b = B { x: 3, y: 3 }
  sum(b)

```

Implementation (Psuedo VOID / WASM hybrid):
```void
// All objects implicitly extend Object
type Object = {
  // All objects that can be used to access a member of an the object.
  // A member can be a field or a method.
  // This function is used on parameters who's type is a structural or a trait object
  // It is up to the caller to know the signature of funcref, although the first parameter is always self
  get_member: (member_id: i32) -> funcref
}

fn b_get_x(self: anyref) -> i32
  struct.get(ref.cast(self, B), x)

fn b_get_y(self: anyref) -> i32
  struct.get(ref.cast(self, B), y)

fn get_member_of_b(member_id: i32) -> funcref
  if member_id == hash_i32(x)
    return ref.func(b_get_x)

  if member_id == hash_i32(y)
    return ref.func(b_get_y)


fn sum(b: A) -> i32
  // Field x can be directly accessed via wasm struct.get, as we know b is a supertype of a and a contains x
  b.x +

  // Field y cannot be directly accessed because we do not know the supertype of b that defines y field
  ref.call(b.get_member(hash_i32(x)), b)

fn main() -> i32
  let b = B {
    x: 3,
    y: 3,
    get_member: ref.func(get_member_of_b)
  }
```
