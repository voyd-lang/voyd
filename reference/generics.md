# Generics

Pipes `||` mark the beginning and end of type parameters.

Defining a generic function:
```
fn foo|(T, U)|(bar: T) -> U = {}

// Top level () can be omitted
fn foo|T, U|(bar: T) -> U = {}
```

Calling a generic function:
```
foo|Type1, Type2|(Type1())
```

When a supplied type argument itself has a type parameter, they are passed
like a normal parameter:
```
type Doubled|T| = (T, T)

let my_quadrupled: Doubled|Doubled(i32)| = ((1, 2), (2, 4))
```

# Examples

Generic struct:
```
struct Target|T| {
    let x, y, z: T
}

let target = Target|i32|[x: 1, y: 2, z: 3]

// In this case, the type parameter could be inferred. So the above could also be written as:
let target = Target[x: 1, y: 2, z: 3]
```

Generic function:
```
fn add|T|(a: T, b: T) = a + b

add<i32>(1, 2)

// In this case, the type parameter could be inferred. So the above could also be written as:
add(1, 2)
```

# Research

## Notes

**Dec 2, 2020**

I'm reverting back to using || for generics. Using lt and gt is just not very ergonomic.

**Nov 21, 2020**

Haskell has another interesting approach. Using simply whitespace to denote generics. Its possible that could work in dream. But it heavily conflicts with the `()` based call syntax if we ever have more than one type parameter.

Inspired by [this reddit comment](https://www.reddit.com/r/ProgrammingLanguages/comments/jd30p7/unpopular_opinions/g95ig7s?utm_source=share&utm_medium=web2x&context=3).

**Nov 11, 2020**

I figured out a really stupid simple way to resolve the ambiguities with the `<>` syntax. Use words instead of symbols for *all* logical operations. We were already doing this for `and` and `or`. I'm not sure why it didn't just occur to me to use `lt`, `gt`, `lte`, `gte`, and `eq` instead of the usual `<`, `>`, `<=`, `>=`, `==` operators.

The obvious disadvantage to this approach is that it's not very common in other languages. But while letters can be easily used in place of alligator symbols, generic parameters just don't have a good alternative. I feel the benefits outweigh the costs here.

Technically we could still use `<=`, `>=`, `==`. But I think that would just confuse people more. Especially with `<=`, `>=`.

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
