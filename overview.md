# Dream

## Comments

```
// Single line

///
Block Comment
///
```

## Types

```
1 // Int
1.0 // Float
true // Bool
false // Bool
"Hello World!!" // String
// All strings are multiline
"
    I am a multiline string!
    Hooray!
    I also support interpolation: #(1 + 2)
"
$(1, 2, 3) // Tuple
$(x: 1, y: 2, z: 3) // Labeled tuple / anonymous stryct
$[1, 2, 3] // Array
${ firstname: "Drew", lastname: "Youngwerth" } // Dictionary / Hash Table / Object
```

### Type annotations

```
// Main types
Int
Bool
Float
String
$(Int, String, Float) // Tuple
$(x: Int, y: Int, z: Int) // Labeled tuple / Anonymous struct
$[Int] // Array
${String, Int} // Dictionary (Key type, value type)
{ Int, Int -> Int } // Function signature
```

## Contants and Variables

```
let x = 5 // Constant
var y = 4 // Variable
```

## Blocks

```
{
    let x = 5
}
print(x) // Error: x is not defined

// Blocks are expressions, they return the result of the last expression in the block
let five = {
    let x = 2
    x + 3
}
```

## Control Flow

```
// Basic if statement
if 3 == 4 {
    print("Thats not possible")
} elif 3 == 2 {
    print("Also not possible")
} else {
    print("Ok")
}

// Basic while statement
var x = 0
while x < 10 {
    x += 1
    print(x)
}

// Basic for in
let my_iterable = $[1, 2, 3]
for item in my_iterable {
    if item == 2 { continue } // Traditional break and continues are supported
    print(item)
}

// Match statement
match 4 {
    case 1 { print(1) }
    case 2 { print(2) }
    case 3 { print(3) }
    case 4 { print(4) }
    case _ { print("No matching case found") } // Default, (matches must be exhaustive)
}

// if statements and matches are expressions
let four = if 3 == 4 { 3 } else { 4 }
let five = match "five" {
    case "five" { 5 }
    case _ { 3 }
}
```

## Functions

```
fn add { a: Int, b: Int -> Int |
    a + b // Result of last expression is returned
}

// In most cases, the return type can be infered
fn sub { a: Int, b: Int | a - b }

// Rest params are supported, if they are the last argument
fn add_many { args: ...Array[Int] |
    args.reduce { cur, prev | cur + prev }
}
let six = add_many(2, 2, 2)

// Arguments can have default values, provided they are last and not coupled
// With a rest parameter
fn example { a = 3, b = 10 | a + b }
let thirteen = example()
let fourteen = example(4)

// Arguments can be named
fn splice {
    item: Int, into insertable: Array[Int], at_index index: Int
    -> Array[Int]
|
    insertable.insert(item, index)
}
splice(3, into: $[1, 2, 3, 4], at_index: 2) // $[1, 2, 3, 3, 4]
```

## Universal Function Call Syntax

```
fn my_custom_add { a: Int, b: Int -> Int |
    a + b // Result of last expression is returned
}

3.my_custom_add(4) // 7

fn my_print { v: Int | print(v) }

"Hello".my_print // If the function takes 1 argument or less, () can be omitted.
```

## Closures

```
let my_closure = { a: Int, b: Int -> Int | a + b }
let my_annotated_closure: { a: Int, b: Int -> Int } = { a, b | a + b }

// If a closure is the last argument of a func it can be placed out of parens,
// If it is the only argument, parens can be omitted
let val = arr
    .map {| $0 * 2 }
    .filter {| $0 < 15 }
    .reduce(5) { cur, prev | cur + prev }
    .{ v | if $0 > 10 { "Yes" } else { "No" } }
```

## Structs

```
struct Point {
    var x, y, z: Int;

    fn offset { x, y, z: Int | Point(self.x + x, self.y + y, self.z + z) }

    // Members can usually be inferred without self prefix, unless a parameter
    // or variable name conflicts with the member name
    fn to_tuple {| $(x, y, z) }

    // Any operations that mutate the struct require the mut annotation.
    mut fn sq {|
        x *= x
        y *= y
        z *= z
    }
}

// Structs can be extended with impl
impl Point {
    // Btw, normal functions act as getters, can be called with point.r
    fn r {| x }
    // This is how setters are defined, point.r = 5 works.
    fn set_r { v: Int | x = v }
    fn g {| y }
    fn set_g { v: Int | y = v }
    fn b {| z }
    fn set_b { v: Int | z = v }
}
```

## Traits

```
trait Age {
    let born: Date

    fn age_in_minutes { -> Int }

    // Traits can have defailt implementations
    fn age_in_hours {| age_in_minutes * 60 }
}

// Implementing age in a new struct.
struct Person: Age {
    let firstname, lastname: String

    let born: Date

    fn age_in_minutes {| (born - Date.now) * 60 }
}

// Traits can also be implemented in impl extensions.
impl Age for Person {
    let born: Date

    fn age_in_minutes {| (born - Date.now) * 60 }
}
```

## Generics

```
fn add[T] { a: T, b: T | a + b }

struct Array[T] {}

```

## Ownership

Dream follows a simplified version of rust's ownership system.

```
// Immutable reference
let x = "Hello"
ref y = x
print(y) // Hello
y = "World!" // Error: y is an immutable reference
ref z = x // Multiple immutable references are allowed.

// Mutable reference
var a = "Hello"
mref b = a
b = "World"
mref c = a // ERROR: Variables can only have one mutable ref.
endScope(b)
```

### Difference from rust

In rust you bind a reference to a variable. In dream, references are a type
of variable.
