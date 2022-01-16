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

# Struct methods mutability and memory

```
struct Target {
    let x, y: Int
    var z: Int

    // Methods must be marked as mutable if they mutate the struct
    mut fn raise_z([by val: Int]) {
        z += val
    }
}

// Functions must declare their intention to mutate parameters using &mut
fn mutate_target(target: &mut Target) {
    target.raise_z(by: 10)
}

// Functions may obtain an immutable reference to a struct with just &
fn check_target(target: &Target) {
    print(target.z)
}

// If a parameter is a plain struct type, it must be passed by value. The parameter will be a copy.
fn target_raised(target: Target) {
    target.raise_z(by: 10)
    target
}
```

# Inspiration

1. [Lys](https://github.com/lys-lang/lys)

# Links
https://stackoverflow.com/questions/23743566/how-can-i-force-a-structs-field-to-always-be-immutable-in-rust
http://smallcultfollowing.com/babysteps/blog/2014/05/13/focusing-on-ownership/
