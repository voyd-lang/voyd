# Structs

Structs are a value data type that represent a fixed collection of key value
pairs (fields).

Unlike objects, structs are copied when passed to a function or assigned to a
variable. And they are stored on the stack.

They are defined by listing their fields between curly braces prefixed with
the percent sign `%{}`.

```void
type MyStruct = %{
    a: i32,
    b: i32
}
```

Structs must be of fixed size and formed of either other structs or primitive
types. They cannot contain reference types (for now).

# Tuple Structs

Tuple structs are a fixed sequence of values of different types. They
are defined by listing their types between square braces prefixed with the
percent sign `%[]`.

```void
type MyTupleStruct = %[i32, bool]

let my_tuple_struct: MyTupleStruct = %[1, true]

let x = my_tuple_struct.0
```

They are effectively syntactic sugar for a struct with incrementing
integer keys.

```void
type MyTupleStruct = %[i32, bool]

// Resolves to
type MyTupleStruct = %{
    0: i32,
    1: bool
}
```
