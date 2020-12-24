# Functions

```
// A basic function
fn add(a: i32, b: i32) -> i32 {
    a + b
}

// In most cases, the return type can be inferred.
fn add(a: i32, b: i32) {
    a + b
}

// Single expression functions can be written more simply as
fn add(a: i32, b: i32) = a + b
```

# Calling Functions

Functions are usually called using the standard () syntax
```
add(1, 2) // 3
```

## Infix Function Calls

Dream supports infix function call syntax when the function is a predefined operator.

Predefined operators: and, or, in, xor, +, -, *, /, =, ==, is. Additional operators may
be added later.

Infix is just syntactic sugar:
```
4 + 5 // Sugar for 4.+(5)
```

While new infix operators cannot be defined in source code. They can be overloaded for
new types. See the overloading section.

## Omitting Parentheses from a Function Call

Parenthesis can be removed when:
1. The only argument is a struct literal
2. The only argument is a closure wrapped in curly braces
3. The function is followed by a colon, a single expression representing the first argument, and
   a final trailing closure

Examples:
```
fn add(val: [a: Int, b: Int]) = val.a + val.b

add [a: 3, b: 4]

fn on(event: String, action: Fn() -> Void) =
    window.addEventListener(event, action)

on: "click" {
    print("You clicked me!!");
}
```

## Trailing Closure Syntax

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
} onError: { _ =>
    print "Dang, Foo failed"
}
```

# Struct Sugar Syntax

```
// Structs can be destructed in the method signature.
fn add([x, y]: [x: Int, y: Int]) -> Int {
    x + y
}

// This can be shortened further, unlabeled structs are automatically destructed.
fn add([x: Int, y: Int]) -> Int {
    x + y
}

// If a struct is the only argument of a method, parenthesis can be omitted.
fn add[x: Int, y: Int] -> Int {
    x + y
}

// You can also alias fields to different identifiers internally
// Note: The "as" is optional, as demonstrated by the y field
fn add[x as a: Int, y b: Int] -> Int {
    a + y
}


add([x: 5, y: 3])
```

When the only argument to a function is a struct, the parenthesis can be omitted.
```
add [x: 5, y: 3]
```

Dream also supports some syntactic sugar to more closely emulate swift style argument labels.
Labeled arguments are placed in a single struct and passed as the the argument to where the first
instance began.

Some examples:
```
fn multiply(val: Int, [with: Int, and: Int]) = val * with * and

multiply(3, with: 4, and: 2) // Converted to multiply(3, [with: 4, and: 2]).

// Order is important
multiply(with: 4, 3, and: 2) // Converted to multiply([with: 4], 3, [and: 2]), no overloads match that signature.
```

Struct sugar syntax can be used to make APIs cleaner and easier to understand. They bring some
of the advantages of Smalltalk and Swift over to Dream

Here's an idiomatic example:
```
fn draw_line[from point_a: Vec3D, to point_b: Vec3D] -> Void {
    let line = Line(point_a, point_b)
    line.draw()
}

fn main() {
    let a = Vec3D[x: 1, y: 2, z: 3]
    let b = Vec3D[x: 7, y: 3, z: 30]

    draw_line[from: a, to: b]
}
```

# Overloading

Dream functions can be overloaded. Provided that function overload can be unambiguously distinguished
via their parameters and return type.

```
fn sum(a: Int, b: Int) {
    print("Def 1");
    a + b
}

fn sum[a: Int, b: Int] {
    print("Def 2");
    a + b
}

sum(1, 2) // Def 1
sum[a: 1, b: 2] // Def 2

// ERROR: sum(numbers: ...Int) overlaps ambiguously with sum(a: Int, b: Int)
fn sum(numbers: ...Int) {
    print("Def 3")
    numbers.reduce { prev, cur => prev + cur }
}
```

# UFCS

Dream supports uniform function call syntax. This allows you to call free functions
as if they were methods of a type. If the free function has only one parameter the
parenthesis can be omitted.

Examples:
```
fn increment(val: Int) = val + 1

let x = 1
x.increment() // 2
x.increment // 2

fn each(arr: Array(Int), func: Fn(Int) -> Void) {
    for val in arr {
        func(val)
    }
}

Array(1, 2, 3, 5).each( val => print(val * 2))

// Could also be written as
Array(1, 2, 3, 5).each { val => print(val * 2) }
```

This applies to some primitive control flow operations as well.

Examples
```
let x = false
x.if {
    do_work()
}

let test = "test"
test.match {
    "hello" => print("world"),
    "test" => print("complete"),
    _ => print("unknown")
}

var a = true
a.while {
    do_work()
}

let my_prom = Promise({ res, rej => })
my_prom.await()
my_prom.await
```

# Variadics

```
fn sum(numbers: ...Int) = numbers.reduce(0) { prev, cur => prev + cur }
```

# Pure Functions

```
// Pure functions are marked with a "pure" attribute and can only call other pure functions.
// They also cannot have side effects.
pure fn mul(a: i32, b: i32) = a * b

pure fn div(a: i32, b: i32) {
    // This will throw an error, as print has side effects and isn't marked pure.
    print(a)
    a / b
}
```

# Unsafe Functions

```
// Some functions are marked "unsafe". In dream this means they can call low level wasm functions
// And have access to  linear memory. Unsafe functions can only be called inside other unsafe
// functions, or from unsafe blocks.
unsafe fn readI32FromMem(ptr: i32) -> i32 =
    wasm_i32_load(0, 2, ptr)

// This function is not considered unsafe as the call to an unsafe function happens in an unsafe
// block
fn mul(a: i32, b: i32) -> i32 = unsafe {
    wasm_i32_mul(a, b)
}
```

# What makes Dream Functions Special?

When you combine the rules of overloading, ufcs, omitting parentheses, and trailing curlys, you start to be able to do some pretty neat things.

For example. Dream's syntax could've satisfied much of Rust's async syntax bikeshedding as pretty much every proposed syntax could be used:

```
// Standard await
await(my_prom)

// Parenthesis can be omitted, looks like javascript now.
await my_prom

// UFCS can be used, looks like rust now (Trailing parenthesis on await are optional)
my_prom.await
```

Now you might be saying, "That's too many ways to call a function". While too many options can be a bad thing, in this case, each option has a valuable use case given a certain context.

Lets take await as an example. Let's imagine for a moment that promises could be chained
using the + operator. That would make the first await() syntax ideal:
```
await(prom1 + prom2) // Equivalent to await prom1.then(prom2)

// This wouldn't work
await prom1 + prom2
```

> Side note: I am absolutely not advocating for the + chain syntax.

The second syntax is useful when you only need to wait on a single promise:
```
let my_val = await my_prom
```

The third syntax is useful when you need to perform an operation on the result of a promise:
```
let my_prom = Promise(resolve => resolve(5))

let six = my_prom.await.add(1);
```

In conclusion. Dream is a flexible language. Flexibility can come at a cost. But when used at the hands of a disciplined developer, it can make for more elegant and readable code.

# TODO

All standalone curly braces should be considered closures. Update docs to reflect this.

Add support for kotlin like `it` shorthand notation. But allow it to work outside of `{}` like
Scala's _ syntax.

Explore adding `moveHome("inCNCPart", from: "overHere")` style calling syntax. Starting after the
first labeled argument, all subsequent arguments must also be labeled. These would be converted
into a struct that gets passed as the last argument.

# References

https://mail.mozilla.org/pipermail/rust-dev/2013-July/005042.html
