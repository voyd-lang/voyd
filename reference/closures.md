# Closures

A closure is an anonymous function or lambda that captures the
values of it's parent scope.

In Dream closures is any `fn` that does not have a name. These can be passed as parameters
assigned to variables, or returned from other functions and closures:
```
let my_closure = fn(a: Int) { a - 1 }

pass_me_a_closure(fn() { "here's one" })

let make_counter = fn() {
    var counter = 0
    { counter += 1 }
}
```

When a closure has no parameters the `fn()` portion can be entirely omitted:
```
pass_me_a_closure({ "here's one" })
let emit_hello = { emit("hello") }
```

**An Important Note On Returning Closures From Single Expression Functions**

As stated in the functions section, dream functions can omit `{}` when there is only one
expression:
```
fn add(a: Int, b: Int) a + b
```

If closures with no parameters can omit the `fn()` portion. Doesn't that mean that this function
would return a closure?
```
fn add(a: Int, b: Int) { a + b }
```

No. Thanks to a special rule in Dream. If the first and only expression of a function is
wrapped in `{}`, the `{}` is treated as a standard block.

In order to return a closure in that scenario you can re-write the function in one of two ways:
```
fn make_closure(a: Int, b: Int) { { a + b } }
// OR
fn make_closure(a: Int, b: Int) ({ a + b })
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
3. Subsequent closures must take the form `} label(args) { body }`. This means
   1. They are always labeled. This label is what they are referred as when passed to the struct
   2. The label trails the previous closure by only a single space
   3. Arguments passed to the closure are defined in `()` that come immediately after the label
   with no space. If there are no arguments `()` can be omitted.
   4. Closure body comes one space after the args (or label if there are none)

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
} on_error(err) {
    print(err)
    print("Dang, Foo failed")
}
```func()


# Curly Brace Elision and Closures

The following feature was adapted from [Koka](https://koka-lang.github.io) See layout.md for more
info on how Curly Brace Elision works.

```
let array = Array(1, 2, 3)

array.each
    print($) // The item parameter
    print($1) // The index parameter

// With named parameters
array.each fn(item, index)
    (item, index) =>
    print(item)
    print(index)

// Multiple trailing closures work too. Just pretend that the curly braces are there.
// Trailing labels use two white spaces on the next line to indicate they are chained with the
// previous
foo(5)
    print "Yay!!!, Foo worked"
  on_error(err)
    print(err)
    print("Dang)
```
