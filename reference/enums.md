
# Examples
```

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
enum Enum { A, B, C }

match Enum::A {
    A => {},
    B => {},
    C => {},
}
```

No prefix required. More research is required to see if this could work. It would be nice if this
could be done in if lets as well.

This has been proposed in rust. But there are some ambiguities (particularly with binding) that
prevent it from ever being implemented.

## Links
https://github.com/rust-lang/rfcs/pull/1949
https://github.com/rust-lang/rfcs/issues/421
https://github.com/rust-lang/rust/blob/master/src/librustc_error_codes/error_codes/E0170.md
https://internals.rust-lang.org/t/elliding-type-in-matching-an-enum/4935
https://github.com/rust-lang/rfcs/pull/2623 (Semi relevant)
