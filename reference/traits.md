# Traits

# Traits as types

In dream traits are types:
```
trait Foo {
    fn foo(&self)
}

fn my_fn(x: Foo) {
    x.foo()
}
```

# Function Traits

```
Fn AddsANumber(Int) -> Int

fn add_one: AddsANumber (x: Int) -> Int {
    x(1)
}

// Technically the param value and return value can be inferred:
fn add_one: AddOne (x) {
    x + 1
}
```

## Comparison to rust

Unlike in dream, rust Traits are not types. The same behavior can be achieved using a trait object:
```
fn my_fn(x: &dyn Foo) {
    x.foo()
}
```

This involves doing some other work. `x` must always be a pointer to a trait object somehow.

Rust's semantics here are very powerful and give tight control over the memory behavior of the
parameter. This allows for incredible zero overhead memory management. Dream trades some of the
control and performance for simplicity. If you need that kind of control and performance I highly
recommend using rust.

# Overloading and Traits With Default Implementations in Dream

Dream supports both method overloading and default implementations. In other languages
like swift, [this can cause subtle bugs](http://developear.com/blog/2017/02/26/swift-protocols.html)

Dream solves this by only allowing traits to be implemented within impl blocks. Those
impl blocks can only contain code that implements the features of that trait. So if you accidentally
add a parameter that would revert the implementation to the default, the compiler would
throw an error saying the method inside the impl block is unrelated to the trait being implemented.
