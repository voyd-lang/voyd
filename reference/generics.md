
# Examples

Generic struct:
```
struct Target(T) {
    let x, y, z: T
}

let target = Target(i32)[x: 1, y: 2, z: 3]

// In this case, the type parameter could be inferred. So the above could also be written as:
let target = Target[x: 1, y: 2, z: 3]
```

Generic function:
```
fn add(T)(a: T, b: T) = a + b

add(i32)(1, 2)

// In this case, the type parameter could be inferred. So the above could also be written as:
add(1, 2)
```

# Research

## Notes

**Oct 6, 2020**

I was still very unhappy with the `<>` syntax. The parsing ambiguities really sucked. So I did a lot more research and stumbled on a comment by Walter Bright[3] (the creator of D lang) on Hacker News. The comment thread suggested that generic functions are just functions that return another function in compile time. Therefor the syntax should be the same as a normal function parameters. I completely agree with this point and have decided to update my syntax to reflect that as well.

D marks the type parameters with a !. That might work here as generics are similar to macros, but they are different enough I'm not sure that would work. I'm going to try and leave them without any sort of marker for now and see how that goes.

**May 4, 2020**

There just isn't enough brackets on a standard keyboard. I would've liked to have used `[]` instead
of `<>`. But I prefer their usage as anonymous structs.

The main issues is the `<` is used as a comparison operator. This makes parsing generics in expressions
tough without some sort of prefix. Determining if it is the start of the list of type parameters
requires [a complex set of rules](https://github.com/rust-lang/rust/issues/22644#issuecomment-75466424).
To avoid this (for now), we require a `::` prefix. I.E. `identifier::<Types>()`. Personally, I don't
think that looks all that bad.

## Links

1. https://github.com/rust-lang/rust/issues/22644
2. https://github.com/rust-lang/rfcs/blob/master/text/0558-require-parentheses-for-chained-comparisons.md
3. https://news.ycombinator.com/item?id=22787288
