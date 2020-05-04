
# Examples

```
struct Target<T> {
    let x, y, z: T
}

def add<T>(a: T, b: T) => a + b

add::<i32>(1, 2)
```

# Research

## Notes

There just isn't enough brackets on a standard keyboard. I would've liked to have used `[]` instead
of `<>`. But I prefer their usage as anonymous structs.

The main issues is the `<` is used as a comparison operator. This makes parsing generics in expressions
tough without some sort of prefix. Determining if it is the start of the list of type parameters
requires [a complex set of rules](https://github.com/rust-lang/rust/issues/22644#issuecomment-75466424).
To avoid this (for now), we require a `::` prefix. I.E. `identifier::<Types>()`. Personally, I don't
think that looks all that bad.

## Links

https://github.com/rust-lang/rust/issues/22644
