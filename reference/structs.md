# Structs

# Low Level Syntax

```
struct Target {
    let x, y: Int
    var z: Int
}

// Can be desugared to

struct Target[x: let Int, y: let Int, z: Int]
```

```
// Lowest level
struct MyStruct
struct Data[0: Int]

// Second level

struct(Int, Int)

// Translates to
struct[0: Int, 1: Int]
```

Low level structs can contain no data, or multiple fields of data

# Inspiration

1. [Lys](https://github.com/lys-lang/lys)

# Links
https://stackoverflow.com/questions/23743566/how-can-i-force-a-structs-field-to-always-be-immutable-in-rust
http://smallcultfollowing.com/babysteps/blog/2014/05/13/focusing-on-ownership/
