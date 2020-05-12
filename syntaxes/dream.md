
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


# Methods

```

fn add(a: Int, b: Int): Int => a + b
def add(a: Int, b: Int) -> Int {
    // Result of last expression is returned
    a + b
}

// Structs can be destructed in the method signature.
def add([x, y]: [x: Int, y: Int]) -> Int {
    x + y
}

// This can be shortened further, unlabeled structs are automatically destructed.
def add([x: Int, y: Int]) -> Int {
    x + y
}

// If a struct is the only argument of a method, parenthesis can be omitted.
def add[x: Int, y: Int] -> Int {
    x + y
}

add([x: 5, y: 3])

// If a struct is the only argument or the second argument is a function (more on that later),
// the parenthesis can be omitted on call as well.
add[x: 5, y: 3]

// Single expression method
def sub(a: Int, b: Int) => a - b
```

# Functions (Or closures, or lambdas)

```
// A function is a set of instructions enclosed by {}
let myFunc = {
    print("Hello!")
    print("What's up?")
}

// Functions can define parameters between || characters.
let add = {| a: Int, b: Int |: Int
    a + b
}

// Functions are called with ().
add(1, 2)

// If a function has only one expression, {} can be omitted. But || are required.
let sub = |a: Int, b: Int| a - b
```

## Higher Order Functions

```
// You can pass functions as parameters to methods or other functions
def caller(fn: Fn(a, b) -> Int) -> Int {
    fn(1, 2)
}

// All are valid ways of calling the caller method
caller(add)
caller({| a, b | a + b })
caller() { $0 + $1 } // Parameters can be implicitly referenced using $ syntax
caller { $0 + $1 }
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

    pub def offs [x: Int] -> Target =>
        // Self can be omitted if the identifier does not conflict with a parameter.
        // Here y and z have self omitted. In addition we are using struct shorthand for
        // y and z
        Target [x: self.x + x, y, z] // Equivalent to [x: self.x + x, y: self.y, z: self.z]


    // Computed properties are supported
    pub get distanceFromOrigin =>
        sqrt(x.squared + y.squared + z.squared)
}

// Methods can also be added to structs through impl blocks.
impl Target {
    // If a method modifies it's struct, it must be marked as mut
    mut def shift [x: Int] -> Void {
        self.x += x
    }
}

const target = Target [x: 5, y: 3, z: 7]
target.shift [x: 5]
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
    var vin: String { get }

    // Property can be read and set.
    var color: Color { get set }

    // Implementors must define this method
    def start() -> Void

    // Traits can define default implementations of their method requirements
    def getInfo() => "Vin: ${vin}, Color: ${color}"
}

struct Car impl Vehicle {
    var started = false
    pub let vin: String
    pub var color: String

    def start() => started = true
}

let car = Car [vin: "12fda32213", color: "red"]
car.start()
car.getInfo()
```

# Generics

Generics work much like they do in TypeScript or Swift with essentially the same syntax.
```
def add<T>(a: T, b: T) -> T {
    a + b
}

struct Target<T> {
    let x, y, z: T
}
```

The one exception (for now) is when a generic type parameter needs to be explicitly defined in an
expression. In such a case, the type parameters must be prefixed with a `:`. For example:
```
def add<T>(a: T, b: T) => a + b

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
