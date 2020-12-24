
# Examples

```
enum Friend {
    Ease Eric, Alex, Will, Jacob
}

let friend = Friend.jacob
match friend {
    Jacob => print("Jacob"),
    Alex => print("Jacob"),
    Will => print("Jacob"),
    Eric => print("Jacob")
}

// Associated types
enum Volume {
    case CubicFeet(f64),
    case CubicMeters(f64),
    case CuboidMeters[length: f64, width: f64, height: f64]
}

let volume = Volume.cuboidMeters
match volume {
    CubicFeet(feet) => print("The volume in feet is ${feet}),
    CubicMeters(m) => print("The volume in meters is ${m}),
    CuboidMeters[length, width, height] => {
        let vol = length * width * height
        print("The volume in meters is ${vol})
    },
}
```

# Sugar

Enums are just sugar for type unions.

For example, This enum:
```
enum Shape {
    case Point
    case Circle(Int)
    case Square[width: Int, height: Int]
}
```

Is just sugar for the lower level syntax:
```
type Shape = Point | Circle | Square

struct Point
struct Circle(Int)
struct Square[width: Int, height: Int]

// TODO: Desugar the implicit methods
```

# Research

## Notes

I want the enum syntax and usage to mostly resemble rust's. But I want to support something like
swift's leading dot notation for enum variant access.

In rust you have to specify the full enum scope. Which can be highly annoying.

Rust:
```rust
enum Enum { A, B, C }

match Enum::A {
    Enum::A => {},
    Enum::B => {},
    Enum::C => {},
}
```

Swift:
```
enum Enum {
    case A, B, C
}

switch Enum.A {
    // Much cleaner
    case .A: _,
    case .B: _,
    case .C: _,
}
```

Ideally, in Dream:
```dream
enum Enum { case A, B, C }

match Enum.A {
    .A => {},
    .B => {},
    .C => {},
}
```

No prefix required. More research is required to see if this could work. It would be nice if this
could be done in if lets as well.

This has been proposed in rust. But there are some ambiguities (particularly with binding) that
prevent it from ever being implemented.

[I think this helps identify the problem and makes a solution obvious (Just don't allow it)](https://github.com/rust-lang/rfcs/issues/421#issuecomment-260175176)

# Inspiration

1. [Lys](https://github.com/lys-lang/lys)

# Links

https://github.com/rust-lang/rfcs/pull/1949
https://github.com/rust-lang/rfcs/issues/421
https://github.com/rust-lang/rust/blob/master/src/librustc_error_codes/error_codes/E0170.md
https://internals.rust-lang.org/t/elliding-type-in-matching-an-enum/4935
https://github.com/rust-lang/rfcs/pull/2623 (Semi relevant)
