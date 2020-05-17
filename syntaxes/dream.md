
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
[x: 2, y: 4] // Anonymous struct
$(1, 2, 3) // Array
$[x: 3] // Dictionary
```

# Blocks

```
// Basic Block, returns the result of the last expression
{
    let x = 5
    let y = 4
    x * y
}

let x = {
    3 * 5
}
print(x) // 15
```

# Control flow

```
if 3 > val {

} else if 3 < val {

} else {

}

for item in iterable {

}

while condition {

}

let x = 3
match x {
    1 => print("One"),
    2 => print("two"),
    3 => print("three"),
    _ {
        // Match statements must cover every possible case.
        // _ means default. I.E. if no other patterns match, use this one.
        // Additionally, we are using {} instead of =>. {} can be used for
        // any case that requires more than one line.
        print("A number")
    }
}
```

# Functions

```
// A basic function
fn add(a: i32, b: i32) -> i32 = a + b

// In most cases, the return type can be inferred.
fn add(a: i32, b: i32) = a + b

// Use {} to enclose multi-line functions
fn add(a: Int, b: Int) -> Int = {
    // Result of last expression is always returned, though return is still supported.
    a + b
}

// You can optionally omit the = on multi-line functions
fn add(a: i32, b: i32) -> i32 {
    a + b
}

// Functions are called using the standard () syntax
add(1, 2)
```

## Struct Sugar Syntax

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

add([x: 5, y: 3])

// If a struct is the only argument or the second argument is a function (more on that later),
// the parenthesis can be omitted on call as well.
add[x: 5, y: 3]
```

## Pure Functions

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

## Parameter-less Functions

```
// Functions can have no parameters.
fn test = 3 * 2

// Parameter-less functions are called without ().
test // 3

// Parameter-less functions are always pure,
var x = 1
fn bump = x += 1 // ERROR: bump cannot have side-effects.
```

## Unsafe Functions

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

# Closures

```
// Closures are essentially anonymous functions with the syntax
// | ...params: ParamType -> ReturnType | Expr
let add = |a: i32, b: i32 -> i32| a + b

// Closures can have multiple expressions when wrapped in, or followed by {}
let sub = {|a: i32, b: i32|
    print("Subtracting ${a} and ${b})
    a - b
}

// Same as sub
let sub2 = |a: i32, b: i32| {
    print("Subtracting ${a} and ${b})
    a - b
}

// Closures parameters and return type can be inferred
let mul: Fn(a: i32, b: i32) -> i32 = |a, b| a * b
```

## Higher Order Functions

```
// You can pass functions as parameters to methods or other functions
fn caller(fn: Fn(a: i32, b: i32) -> i32) -> i32 {
    fn(1, 2)
}

// All are valid ways of calling the caller method
caller(add)
caller({| a, b | a + b })
caller() {|a, b| a + b }
caller {|a, b| a + b }
```

# Structs

```
struct Target {
    let x, y, z: Int
}

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
struct Target {
    pub var x, y, z: Int

    pub fn offs [x: Int] -> Target =
        // Self can be omitted if the identifier does not conflict with a parameter.
        // Here y and z have self omitted. In addition we are using struct shorthand for
        // y and z
        Target [x: self.x + x, y, z] // Equivalent to [x: self.x + x, y: self.y, z: self.z]
}

// Methods can also be added to structs through impl blocks.
impl Target {
    // If a method modifies it's struct, it must be marked as mut
    mut fn shift [x: Int] -> Void {
        self.x += x
    }
}

const target = Target [x: 5, y: 3, z: 7]
target.shift [x: 5]
```

## Computed Properties

```
impl Target {
    // Getters are just functions that have no parameters.
    // Getters are always "pure" and cannot have side effects.
    pub fn distanceFromOrigin =
        sqrt(x.squared + y.squared + z.squared)

    // Define a as an alias for x
    pub fn a = x

    // Setters are defined as methods that take a share the same name as a getter appended with
    // "_=", the same syntax as Scala.
    pub fn a_=(v: Int) {
        x = v
    }
}
```

## Static Methods

Static methods can be added to a struct, or any other type, by augmenting their namespace.
```
namespace Target {
    fn from(tuple: (Int, Int, Int))
}
```

Static constants can be added this way too.

# Enums

```
enum Friend {
    eric,
    angie,
    carter
}

var friend = Friend.eric

match friend {
    .eric { },
    .angie { },
    .carter { }
}

// Enum identifier can be omitted if it can be reasonable inferred.
let bestFriend: Friend = .angie

// Enums can have associated types
enum ValidID {
    // Struct associated type
    driversLicense [name: String, no: String, issued: Date, exp: Date]
    studentID(Int)
}
```

# Traits

```
trait Vehicle {
    // Readonly property
    fn vin -> String;

    // Property can be read and set.
    fn color -> Color;
    fn color_=(v: Color) -> none;

    // Implementors must define this method
    fn start() -> Void

    // Traits can define default implementations of their method requirements
    fn getInfo() => "Vin: ${vin}, Color: ${color}"
}

struct Car impl Vehicle {
    var started = false
    pub let vin: String
    pub var color: String

    fn start() =
        started = true
}

let car = Car [vin: "12fda32213", color: "red"]
car.start()
car.getInfo()
```

# Generics

Generics work much like they do in TypeScript or Swift with essentially the same syntax.
```
fn add<T>(a: T, b: T) -> T {
    a + b
}

struct Target<T> {
    let x, y, z: T
}
```

The one exception (for now) is when a generic type parameter needs to be explicitly defined in an
expression. In such a case, the type parameters must be prefixed with a `:`. For example:
```
fn add<T>(a: T, b: T) = a + b

add::<i32>()
```

# Macros

Dream supports macros that adhere to "Macro By Example". They work in a similar manner to
[rust macros](https://doc.rust-lang.org/1.7.0/book/macros.html).

# Compiler directives

Compiler directives are each prefixed with a `#` and can have additional arguments supplied
in the form of an anonymous struct

```
#inline
#deprecated[since: "3.0"]
fn add(a: i32, b: i32) -> i32 {

}
```

# Type alias

Types can be aliased / defined using using the syntax: `type Identifier = Type`.

Examples:
```
type Int = i32
type MyTuple = (i32, String, f32)
type MyAnonStruct = [a: i32, b: i32]

type MyNativeMultiValType = wasm_multi_val_type!(i32, i32, i32)
type MyOtherCustomType = wasm_val_type!(i32)

// Types can have namespaces, impls, and conform to traits
impl MyOtherCustomType {
    fn +(l: i32, r: i32) = unsafe {
        wasm_i32_add()
    }
}
```
