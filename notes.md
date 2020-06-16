
# Memory Management

## Traits as Types

Overview:
- Examine Swift's approach
- Compare Swift's approach to Rust's
- Explore wether Dream should consider

Swift protocols can be used as types. Compared with some other compiled languages this is a
dramatic reduction in development friction that makes he language much more fun to work with.

Example:
```swift
protocol Named {
    printName() -> Void
}

struct Person: Named {
    let name: String

    func printName() -> Void {
        print(name)
    }
}

func delegate(named: Named) -> Void {
    named.printName()
}

let drew: Named = Person(name: "Drew")
delegate(person)
```

This is a bit magical. Normally, a function like `delegate` would need to know the size at
compile time of the `named` parameter. But in Swift we can pass any arbitrarily sized struct
(or class) and the function handles it just fine.

In contrast, rust is not quite as frictionless. Rust needs to know the size of all parameters
at compile time. Ignoring generics, the above example would look something like this in rust:
```rust
trait Named {
    fn print_name(&self);
}

struct Person {
    name: String
}

impl Named for Box<Person> {
    fn print_name(&self) {
        println!(self.deref().name)
    }
}

fn delegate(named: Box<Person>) {
    named.print_name()
}

let drew: Box<Person> = Box::new(Person { name: String::from("Drew") });
delegate(drew);
```

There are pros and cons to both approaches. Swift's approach is much cleaner and easier to learn
but it has some unpredictable performance tradeoffs. Rust's approach is much more verbose and
has a high learning curve, but it aligns with well with their "abstractions with zero overhead
promise". Rust's verbosity also makes it's performance much more predictable. With it's easy to tell
when a trait implementor will be allocated on the stack or the heap. Swift makes that decision for
us and its not always clear which one it will choose.



# References

## Memory Management

MM1 - https://academy.realm.io/posts/goto-mike-ash-exploring-swift-memory-layout/

## Type Inference

TI1 - https://eli.thegreenplace.net/2018/type-inference/
TI2 - https://eli.thegreenplace.net/2018/unification/
