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
1. The only argument is a struct literal or string literal.
   1. The function *must* be separated from the argument by only a single space.
2. The only argument is a curly closure.
   1. The function *must* be separated from the argument by only a single space.
3. The first argument is an expression terminated and the remaining arguments are closures.
4. The function is a UFCS call with one argument. And the function is pure.

**Examples of 1:**
```
print "Hello" // Sugar for print("Hello")

new_target [x: 1, y: 2, z: 3] // Sugar for move_l([x: 1, y: 2, z: 3])

// Note: If the function does not result in the creation of a new struct it's preferred you use
// named arguments. Instead of struct literals with no parens:
move_l(x: 1, y: 2, z: 3) // Sugar for move_l([x: 1, y: 2, z: 3])

// The argument can span multiple lines as long as it starts on the same line as the function:
print "
   lorem ipsum dolor sit amet
   consectetur adipiscing elit
"
```

**Examples of 2:**
```
// Given function onClick
fn onClick(callback: Fn() -> void) {
    window.onEvent("click", callback)
}

// Can be called with:
onClick {
    print("Hello")
}
```

**Examples of 3:**
```
// Given function on
fn on(event: String, callback: Fn() -> void) {
    window.onEvent(event, callback)
}

on "click" {
    print("Hello")
}

// The curly must be on the same line as the end of the first argument.
// This will error:
on "click" // Error: Expected two parameters, found 1
{
    // This is evaluated as a block
    print("Hello")
}

// It's still ok for the first argument to span multiple lines:
on "
   click
" {
    print("Hello")
}
```

**Examples of 4:**
```
pure fn plus_one(x: i32) -> i32 {
    x + 1
}

let three = 2.plus_one // Sugar for 2.add_one()

// Note: If the function is not pure it must be called with parenthesis:
fn do_something_with_effect_and_add_one(x: i32) -> i32 {
    print(x)
    x + 1
}

// ERROR: do_something_with_effect_and_add_one is not a pure function. () required.
let three = 2.do_something_with_effect_and_add_one

// This is still ok
let three = 2.do_something_with_effect_and_add_one()
```

# Named Arguments

Named arguments are defined by wrapping parameters with []. This can improve the readability of
a function on call.

For Example:
```
fn alert(msg: string, [title: string, color: string]) = /* Implementation */

alert("I'm out of cash", title: "Uh oh", color: red)
```

## Named Argument Aliasing

You can specify a different name to be used on call than what is referenced in the function body.
To do this, just add the call name in front of the referenced name.

For example:
```
fn add(a: Int, [with b: Int]) = a + b

add(1, with: 3)
```

## Named Argument Shorthand

If all the arguments of a function are named, the parenthesis can be omitted at definition.

```
fn make_vec [x: Int, y: Int, z: Int] = Vec(x, y, z)
make_vec(x: 4, y: 4, z: 3)
```

## Named Arguments Are Sugar For Structs

Named arguments are really just sugar for passing struct literals.

This works by automatically grouping all *consecutive* named arguments into a struct.

This example demonstrates how the alert function is translated by the compiler:
```
// This function
fn alert(msg: string, [title: string, color: string]) = /* Implementation */

// Is translated into:
fn alert(msg: string, opts: [title: string, color: string]) {
    let title = opts.title
    let color = opts.color
    /* implementation */
}

// This call:
alert("I'm out of cash", title: "Uh oh", color: red)

// Is translated to:
alert("I'm out of cash", [title: "Uh oh", color: red])
```

To get a better since of how this conversion works, try and understand how this more complex
function call is translated:
```
my_special_call(4, arg1: 1, arg2: 3, 5, arg3: 1, () => ())

// Translated into:
my_special_call(4, [arg1: 1, arg2: 3], 5, [arg3: 1], () => ())
```

Because named arguments are just fancy syntax sugar for passing structs, you can opt to pass
a normal struct literal instead. There are some cases where this might be more convenient.

For example:
```
fn make_vec [x: Int, y: Int, z: Int] = Vec(x, y, z)

let x = 3;
let y = 4;
let z = 7;

// You could use the standard named argument syntax, but it's a bit redundant in this case.
make_vec(x: x, y: y, z: z)

// It would be clearer take advantage of struct literal property shorthand
make_vec([x, y, z])

// Event better, since we are only passing a struct the () can be omitted
make_vec [x, y, z]
```

# Destructuring Within A Parameter Definition

Struct and Tuple parameters can be destructed directly within their definition

Examples
```
type MyTuple = (Int, Int, Int)
type MyStruct = [x: Int, y: Int, z: Int]

fn multiply_my_tuple((a, b, c): MyTuple) = a * b * c

fn multiply_my_struct([x, y, z]: MyStruct) = x * y * c
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

# Full function syntax

```
fn fn_name: FnTrait (...args): effects -> return_type {
    body
}
```

# TODO

All standalone curly braces should be considered closures. Update docs to reflect this.

Add support for kotlin like `it` shorthand notation. But allow it to work outside of `{}` like
Scala's _ syntax.

Explore adding `moveHome("inCNCPart", from: "overHere")` style calling syntax. Starting after the
first labeled argument, all subsequent arguments must also be labeled. These would be converted
into a struct that gets passed as the last argument.

# References

https://mail.mozilla.org/pipermail/rust-dev/2013-July/005042.html
