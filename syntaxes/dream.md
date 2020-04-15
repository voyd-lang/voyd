
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
```

# Structs

```
struct Target [
    x: Int, y: Int, z: Int // Commas can be replace with new lines
]

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

## Mutability

By default, struct fields are variable. You can make them immutable by prefixing them with let.

struct Person [
    let name: String,
    age: Int
]

## Computed properties

struct Vec3 [
    x: Int, y: Int, z: Int

    // Immutable computed property
    get squaredLength: Int {
        x * x + y * y + z * z
    }

    // Mutable computed property.
    get a: Int {
        x
    }

    set a { x = $0 }
]


# Methods

```
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
def add [x: Int, y: Int] -> Int {
    x + y
}

add([x: 5, y: 3])

// If a struct is the only argument or the second argument is a function (more on that later),
// the parenthesis can be omitted on call as well.
add [x: 5, y: 3]

// Methods can be added directly to a struct
struct Target [
    x: Int, y: Int, z: Int

    def offs [x: Int] -> Target {
        // Self can be omitted if the identifier does not conflict with a parameter.
        // Here y and z have self omitted. In addition we are using struct shorthand for
        // y and z
        Target [x: self.x + x, y, z] // Equivalent to [x: self.x + x, y: self.y, z: self.z]
    }
]

// Methods can also be added to structs through impl blocks.
impl Target [
    // If a method modifies it's struct, it must be marked as mut
    mut def shift [x: Int] -> Void {
        self.x += x
    }
]

const target = Target [x: 5, y: 3, z: 7]
target.shift [x: 5]
```

# Functions (Or closures, or lambdas)

```
let add = {| a: Int, b: Int -> Int |
    a + b
}

def caller(fn: Fn(a, b) -> Int) -> Int {
    fn(1, 2)
}

// All are valid ways of calling the caller method
caller(add)
caller({| a, b | a + b })
caller() { $0 + $1 } // Parameters can be referenced with a $ followed by their index
caller { $0 + $1 }

def fancyCaller([callIt: Boolean], fn: Fn() -> Void) -> Void {
    if callIt { fn() }
}

fancyCaller [callIt: true] {
    log("Hello!")
}
```

# Enums

```
enum Friend [
    eric
    angie
    carter
]

let friend = Friend.eric

// Enum identifier can be omitted if it can be reasonable inferred.
let bestFriend: Friend = .angie

// Enums can have associated types
enum ValidID [
    // Struct associated type
    driversLicense [name: String, no: String, issued: Date, exp: Date]
    studentID(Int)
]
```

# Generics

Generics work much like they do in TypeScript or Swift with a slightly different syntax.
Top level types are defined and annotated between the pipe (`|`) character.

```
def add|T|(a: T, b: T) -> T {
    a + b
}

struct Target|T| [
    x, y, z: T
]
```

Lower level generic type annotations use the same `<>` syntax as TypeScript.

For example, an array of promises that resolve an Int would be annotated like so:
```
let arr: Array|Promise<Int>| = Array(Promise(5), Promise(4))
```

# Macros

Dream supports macros that adhere to "Macro By Example". They work in a similar manner to
[rust macros](https://doc.rust-lang.org/1.7.0/book/macros.html).
