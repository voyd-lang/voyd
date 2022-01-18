# Closures

A closure is an anonymous function or lambda that captures the
values of it's parent.

In Dream closures are any set of instructions wrapped in `{}`:
```
let my_closure = { 4 - 1 }

let three = my_closure()
```

Arguments can be added with arrow notation:
```
let add_one = { (num: Int) => num + 1 }
```

If the closure only contains one expression, `{}` can be left out:
```
let add_one = (num: Int) => num + 1
```

If the closure has only one parameter and it's type can be inferred, the parenthesis can also be left out:
```
let add_one: Fn(Int) = num => num + 1
```

# Trailing Closure Syntax

Rules:
1. When a closure wrapped in curly braces trails a function call, it is supplied as the last
   argument to the function
2. Parenthesis can be omitted if the closure is the only argument or if the function call
   follows the rules of "Omitting Parentheses from a Function Call".
3. Multiple trailing closures can be supplied to a single function call. When their are more than
   one trailing closures they are transformed into a struct before being passed to the function.
   The first trailing takes the field `main`, subsequent trailing closures must have their fields
   labeled using the syntax `field_name: { /** closure */ }`.

Basic Examples:
```
fn call(func: Fn() -> Void) = func()

call() { () => print("hey") }
call { () => print("hey") }
call { print("hey") }
```

Multiple Trailing Closures Example:
```
fn foo(bar: Int, baz: [main: Fn(Int) -> Void, on_error: Fn(Err) -> Void]) =
    do_work(bar)
        .then(baz.main)
        .catch(baz.error)

foo(5) {
    print "Yay!!!, Foo worked"
} onError: {
    print "Dang, Foo failed"
}
```

# Implicit Parameters

If a closure with no parameters is passed to a function that provides parameters
on call, they can still be accessed using `$index` syntax i.e. `$0` is parameter
1, `$1` is parameter two and so on. `$` is assumed to be shorthand for `$0`.

```
let array = Array(1, 2, 3)

array.each {
    print($) // The item parameter
    print($1) // The index parameter
}
```

# Curly Brace Elision and Closures

The following feature was adapted from [Koka](https://koka-lang.github.io) See layout.md for more info on how Curly Brace Elision works.

Curly braces elision can make for extremely elegant code.

```
let array = Array(1, 2, 3)

array.each
    print($) // The item parameter
    print($1) // The index parameter

// With named parameters
array.each
    (item, index) =>
    print(item)
    print(index)
```
