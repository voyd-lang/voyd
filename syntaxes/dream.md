# Current Dream Syntax

Mostly a fusion of rust and swift

# Comments
```
// Single Line Comment
/* Block Comment */
```

# Data Types
```
1 // Int
1.0 // Double
true // Boolean true
false // Boolean false
"A String" // String
$(1, 2, 3) // Tuple
${ name: "Drew" } // Record
$[1, 2, 3] // Array
```

# Control flow
```
if test {

}

if test {

} else {

}

if test {

} elif other_test {

} else {

}

// Ifs return the result of the last expression
let five = if 4 > 3 { 5 } else { 3 }

for item in collection {

}

while condition {

}
```

# Functions
```
fn foo() {
    print("Bar")
}

fn bar(a: String, b: String) -> String {
    // Last item is always returned. No return keyword necessary (Although available)
    "Hello \(a)! My name is \(b)!"
}

// Functions can be overloaded
fn bar(_ a: String, b: String) -> String {
    "Hello \(a)! My name is \(b)!"
}

fn bar(their_name a: String, my_name b: String) -> String {
    "Hello \(a)! My name is \(b)!"
}

// Parameter defaults
fn add(a: Int, b = 5) -> Int { a + b }
```

# Function calls
```
foo()
bar(a: "World", b: "Drew")
bar("World", "Drew")
bar(their_name: "World", my_name: "Drew")
add(a: 4) // 9
```

# Closures
```
// Closures are defined as items in a curly
{}

// Closure with parameters
{ a, b in a + b }

// Closures are annotated with Fn(ParamType...) -> ReturnType
let add: Fn(Int, Int) -> Int = {|a, b| a + b }

// Closures can also be annotated internally
{ (a: Int, b: Int) -> Int in a + b }

// Closures do not have parameter labels
add(2, 4)

// Supports swift like trailing closure syntax
items.map { item in item * 2 }

// Parameters can be referenced with $<ParamNum> without being defined in the closure (like swift)
items.map { $0 * 2 }
```

# Structs

Have near identical syntax to swift

```
struct Point {
    let x, y, z: Int

    // Init functions can optionally be defined. A default one is already defined as (x: Int, y: Int, z: Int)
    init(y: int) {

    }

    fn to_string() -> String {
        "\(x), \(y), \(z)" // Supports string interpolation
    }
}
```

# Extensions

Have near identical syntax to swift

```
extension Point {
    init(_ x: Int, _ y: Int, _ z: Int) {
        self.x = x
        self.y = y
        self.z = z
    }
}
```

# Protocols

Have near identical syntax to swift

```
protocol Pointable {
    let x, y, z: Int
}
```

# Generics

Identical to swift but uses [] instead of <>

# Modules / Imports

Uses Ecmascript import syntax and nodejs like module resolution

# String Interpolation

Identical to swift
