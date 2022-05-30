# Closures

A closure is an unnamed function that captures the values of it's parent scope.
Closures can be passed as parameters assigned to variables, or returned from other functions and
closures.

The basic syntax for a closure is the same as a function, but without the name:
```
let my_closure = fn(a: Int, b: Int) -> Int {
    a + b
}
```

This can be made even more concise by using the `|` operator:
```
let my_closure = |x: Int| {
    x + 1
}
```

When a closure only contains one expression, the `{}` can be omitted.

```
let subtract_one = |a: Int| a - 1
```

When a closure has no parameters the `||` portion can be entirely omitted:
```
pass_me_a_closure({ "here's one" })
```

# Implicit Parameters

If a closure with no parameters is passed to a function that provides parameters
on call, they can still be accessed using `val<index>` syntax i.e. `val0` is parameter
1, `val1` is parameter two and so on. `val` is assumed to be shorthand for `it0`.

```
let array = Array(1, 2, 3)

array.each {
    print(val) // Prints the current value of the array
    print(val) // Prints the current index of the array
}
```

# Trailing Closure Syntax

Rules:
1. When a closure wrapped in curly braces trails a function call, it is supplied as the last
   argument to the function
2. Parenthesis can be omitted if the closure is the only argument or if the function call
   follows the rules of "Omitting Parentheses from a Function Call".

Basic Examples:
```
// A function that can call closures
fn call(func: Fn() -> Void) {
   func()
}

// Using the call function
call() { print("hey") }

// Because call has no other parameters, `()` can be omitted
call { print("hey") }
```

# Multiple Trailing Closures

Multiple closures can be chained to a function call.

Rules:
1. When more than one closure trails a function, the are added to a struct that is passed as the
   last argument of the function
2. The first trailing closure a added as `main` to the struct.
3. Subsequent closures must take the form `label: <CLOSURE>`

Example:
```
// Define a function that takes multiple closures
fn foo(bar: Int, baz: [main: Fn(Int) -> Void, on_error: Fn(Err) -> Void])
    do_work(bar)
        .then(baz.main)
        .catch(baz.error)

// Use the function
foo(5) {
    print "Yay!!!, Foo worked"
} on_error: |err| {
    print(err)
    print("Dang, Foo failed")
}
```


# Curly Brace Elision and Closures

The following feature was adapted from [Koka](https://koka-lang.github.io) See layout.md for more
info on how Curly Brace Elision works.

```
let array = Array(1, 2, 3)

array.each |val| val * 2
array.each { val * 2 }

array.each
    print(val) // The item parameter
    print(val1) // The index parameter

// With named parameters
array.each |item, index|
    print(item)
    print(index)

// Multiple trailing closures work too.
foo(5)
    print "Yay!!!, Foo worked"
on_error: |err|
    print(err)
    print("Dang)
```

# Gotchas

## Specifying a Return Type

Use the standard `fn` syntax, but without the function name.
```
let add = fn(a: Int, b: Int) -> Int { a + b }
```

```
val strings = someArray.map { it.toString() }
val strings = someArray.map |it| it.toString()
```
