
# Atoms

Atoms are constants useful in pattern matching. They hold equivalence to any other atom with the same name.

```void
type MyAtom = @hello
let a: MyAtom = @hello
let b = @world

let other_hello = @hello

print a == other_hello // true
print a == b // false
```

# Unions

Unions represent a type that can be one of a set of other types.

A union type is defined by listing the types it can be separated by `|`.

```
type MyResult = @ok | @error

type MyOptionalInt = @some[i32] | @none
```
