
# Comments

```
// Single line
/* Multi-Line */
```

# Types
```
true // Boolean
false // Boolean
1 // Int
1.0 // Double
"Hello!" // String, can be multiline, supports interpolation via ${}
(1, 2, 3) // Tuple
[x: 2, y: 4] // Struct literal
$(1, 2, 3) // Array
$[x: 3] // Dictionary
```

# Variables

```
// An immutable variable is defined using the let keyword
let x = 5

// A mutable variable is defined using the var keyword
var y = 3
```

# Functions

A basic function:
```
fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

Inspired by [Koka](https://koka-lang.github.io/koka/doc/index.html), Dream supports curly brace
elision. This means that indented blocks are implicitly wrapped by curly braces. The basic function
above can be written as:
```
fn add(a: i32, b: i32) -> i32
    a + b
```

In most cases the return type can be inferred
```
fn add(a: i32, b: i32)
    a + b
```

Functions are called using the standard () syntax
```
add(1, 2)
```

If a function has no parameters the parenthesis can be omitted
```
var x = 1
fn bump
    x += 1
```

# Control flow

```
if 3 > val {

} elif 3 < val {

} else {

}

// Single line ifs can be written using then syntax
let x = if 3 > val then 1 else 0

for item in iterable {

}

while condition {

}

let x = 3
match x
    1 => print("One"),
    2 => print("two"),
    3 => print("three"),
    _ =>
        // Match statements must cover every possible case.
        // _ means default. I.E. if no other patterns match, use this one.
        print("A number")
```

# Expression Oriented

Dream is an expression oriented language. Blocks, Ifs, and Matches all return a value, that is
the result of the last expression in their group. Functions will also implicitly return the
value of the last expression in their body (Unless it's return type is explicitly set to Void).

Examples:
```
let three = if true then 3 else 4

let fred = match "Smith"
    "Jobs" => "Steve",
    "Smith" => "Fred",
    "Gates" => "Bill"

fn work(a: Int)
    let b = a * 2
    b + 3

let five = work(1)
```

# Structs

```
struct Target
    let x, y, z: Int

let target = Target [x: 4, y: 5, z: 3]

// Anonymous struct.
let point = [x: 5, y: 3]

// Destructuring
let [x, y] = point;
log(x) // 5
log(y) // 3

// If an identifier has the same name as a struct field, the field label can be omitted.
let x = 5
let dot = [x] // Equivalent to [x: x]
```

## Struct Methods

```
// Methods can be added directly to a struct
struct Target
    pub var x, y, z: Int

    pub fn x_offs(x: Int) -> Target
        // Self can be omitted if the identifier does not conflict with a parameter.
        // Here y and z have self omitted. In addition we are using struct shorthand for
        // y and z
        Target [x: self.x + x, y, z] // Equivalent to [x: self.x + x, y: self.y, z: self.z]

// Methods can also be added to structs through impl blocks.
impl Target
    // If a method modifies it's struct, it must be marked as mut (mutable)
    mut fn shift_x(x: Int) -> Void
        self.x += x


const target = Target [x: 5, y: 3, z: 7]
target.shift_x(3)
```

## Struct Initializers

Structs have an implicit initializer that accepts a struct literal that matches the fields
of the structs.

For example, the following struct has an implicit initializer with the signature `init [a: Int, b: Int, c: Int] -> Vec3`.
```
struct Vec3 {
    let a: i32
    let b: i32
    let c: i32
}

let vec = Vec3[a: 1, b: 2, c: 3]
```

Additional initializers can also be added thanks to function overloading.
```
struct Vec3 {
    let a: i32
    let b: i32
    let c: i32

    init(a: i32, b: i32, c: i32)
        Vec3[a, b, c]
}

let vec = Vec3(1, 2, 3)

// Implicit initializer can still be used
let vec2 = Vec3[a: 1, b: 2, c: 3]
```

## Computed Properties

```
struct Planet
    var radius = 5000

    /** Computed property with getter and setter */
    var diameter {
        get { radius * 2 }
        set { radius = val / 2 } // Note: val is an implicit parameter
    }

    /** Readonly computed property */
    let surfaceArea {
        4 * PI * radius.sq
    }

    /**
     * Prop with a default getter and private default setter. This is essentially
     * making a var field that can only be set privately
     */
    var mass: Int { get, private set }
```

## Static Methods

Static methods can be added to a struct, or any other type, by augmenting their namespace.
```
namespace Target
    fn from(tuple: (Int, Int, Int))
        Target [
            x: tuple.0,
            y: tuple.1,
            z: tuple.2,
        ]
```

Static constants can be added this way too.

# Enums

```
enum Friend
    case eric, angie, carter

var friend = Friend.eric

match friend
    // Friend
    eric => (),
    angie => (),
    carter => ()

// Enums are just sugar for writing a union of atoms, so this is valid
let best_friend: Friend = :angie
```

Enum cases can have associated types
```
enum ValidID {
    // Struct associated type
    case drivers_license [name: String, no: String, issued: Date, exp: Date],
    case student_id (String)

let id = ValidID.drivers_license [name: "John", no: "12345", issued: Date(0), exp: Date(0)]
let name = match id {
    let (:drivers_license, [name]) => name,
    let (:student_id, name) => name
}

// Cases with associated types are just syntactic sugar for a tuple with an atom and a value.
// driver_license is equivalent to:
type DriversLicense = (:drivers_license, [name: String, no: String, issued: Date, exp: Date])
```

# Curly Brace Ellison

One of many features inspired by [Koka](koka-lang.github.io) is curly brace ellison. A set
of rules which allow curly braces to be automatically inserted.

```
struct Point
    pub var x, y: Float

    pub fn distance_from(point: Point) -> Float
        (point.x - x).squared +
        (point.y - y).squared >>
        sqrt

fn add(a: Int, b: Int)
    a + b

fn fib(n: Int)
    if n <= 1
        return n
    fib(n - 1) + fib(n - 2)
```

See [layout](./reference/layout.md) for more info.

# Function Overloading

Dream functions can be overloaded

```
fn add(a: Int, b: Int)
    print("Adding integers")
    a + b

fn add(a: Float, b: Float)
    print("Adding floats")
    a + b

add(1, 2) // Adding integers
add(1.2, 1.3) // Adding floats
```

# Traits

```
trait Vehicle {
    // Readonly property
    let vin: String { get }

    // Property can be read and set.
    val color: String { get, set }

    // Implementors must define this method
    fn start() -> Void

    // Traits can define default implementations of their method requirements
    fn getInfo() "Vin: ${vin}, Color: ${color}"
}

struct Car {
    var started = false
    pub let vin: String
    pub var color: String
}

impl Vehicle for Car {
    fn start() {
        started = true
    }
}

let car = Car [vin: "12fda32213", color: "red"]
car.start()
car.getInfo()
```

# Closures

Closures are functions that can capture values of the scope they were defined in.

Closures are defined using the syntax `|...params| { body }`

```
// Basic closure
let add = |a: Int, b: Int| { a + b }

// If the closure has only one expression, the {} can be omitted
let add = |a: Int, b: Int| a + b

// A closure's parameter types may be left out in places where they can be inferred.
let add: Fn(a: Int, b: Int) -> Int = |a, b| a + b

// If a closure has no parameters the || can be omitted
let say_hey = { print("hey") }

// You can pass closures to functions
fn caller(cb: Fn(a: Int, b: Int) -> Int) -> Int {
    cb(1, 2)
}

caller(|a, b| a + b)
```

## Trailing Closure Syntax

Dream supports swift-like trailing closure syntax.

```
caller() |a, b| a + b

// Since the closure is the last parameter of caller, () can be omitted.
caller |a, b| a + b
```

# Generics

Functions:
```
fn add(T)(a: T, b: T) -> T = {
    a + b
}

add(Int)(1, 2)

// With type inference
add(1, 2)
```

Structs
```
struct Target(T) {
    let x, y, z: T

    // Init functions implicitly take on the type parameters of the struct. So
    // the final signature looks like init(T)(x: T, y: T, z: T) -> Target(T)
    init(x: T, y: T, z: T)
        Target[x, y, z]
}

let t1 = Target(i32)(1, 2, 3)

// In this case the above could also be written as follows thanks to type inference.
let t2 = Target(1, 2, 3)
```

A couple more examples
```
type TwoItems(T) = (T, T)
let targets: TwoItems(Target(i32))
```

# Defining Types

Types can be aliased / defined using using the syntax: `type Identifier = Type`.

Examples:
```
type MyInt = Int
type MyTuple = (i32, String, f32)
type MyStruct = [a: i32, b: i32]

type MyNativeMultiValType = wasm_multi_val_type!(i32, i32, i32)
type MyOtherCustomType = wasm_val_type!(i32)

// Types can have namespaces, impls, and conform to traits
impl MyOtherCustomType
    fn +(l: i32, r: i32)
        unsafe
            wasm_i32_add()
```

# Algebraic Effects

Dream supports a [Koka inspired](koka-lang.github.io) Algebraic Effects system. A language level
abstraction of control mechanisms like exceptions, async/await, io and more.

```
effect Async(T) {
    // ctrl operations a function with the async effect can take
    ctrl fn await(promise: Promise(T)) -> T
}

// A function can declare its "effects" like this
fn read_json(path: String): Async -> JSON {
    let file = read_file(path, Utf8)
}
```

# Uniform Function Call Syntax.

Dream supports UFCS. https://en.wikipedia.org/wiki/Uniform_Function_Call_Syntax

Examples
```
fn add(a: i32, b: i32) -> i32 = a + b

1.add(2)

fn double(a: i32) -> i32 = a * 2

add(2, 4).double()

add(2, 4).double
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
```

# Memory Management

1. Dream uses the standard WASM garbage collector for Struct, Enum, and Tuple types.
2. Primitive WASM types such as i32, f32, i64, etc are allocated on the stack and are not garbage collected.
3. All types are value types
4. For a type to be passed by reference to a function or a closure, it must be a garbage collected type.

## Value Types

Dream types are value types. This means when some variable `a` is assigned to some variable
`b`, `a` is copied into `b`. As a result, changes made to `b` do not happen to `a` and vise versa.

This is in contrast to reference types used in other languages. For example, in javascript,
an object is a reference type:
```javascript
let a = { x: 3 };
let b = a;
b.x = 7;
print(a.x) // 7
```

The in Dream, a would not have been affected
```dream
let a = [x: 3]
let b = a
b.x = 7
print(a.x) // 3
```

## References

It is still possible to create a mutable reference to a value in dream. Currently this can
be done using closures (anonymous functions) or inout parameters. Note, this only applies to
garbage collected type.

**&mut Parameters**

&mut parameters create a mutable reference to a given variable. Changes made to an &mut parameter
within a function are reflected in their original variable.

Example:
```dream
var count: Int = 0;

fn bump(val: &mut Int) {
    val += 1
}

print(count) // 0

// The &mut is required and makes it clear count is being referenced
bump(&mut count)

// Note: &mut parameters must refer to a mutable variable.
let count2 = 0
bump(&mut count2) // This will throw an error.
```
