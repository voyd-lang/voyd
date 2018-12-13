# Dream Language Overview

## Comments

```typescript
// Single line comment

/*
    Block Comment
*/
```

## Built in types

```typescript
// Booleans
true
false

// Int's
1
2
3

// Doubles
1.0
3.2


// Strings
"Hello World!"

// Tuples
(5, 3, "WOW!")
(,"Single Element")
(can: "Hello", have: "Hello", labels: "World!")

// Anonymous structs
{ x: 5, y: 4, z: 2 }

// Arrays
Array(1, 2, 3)

// Dictionaries
Dict(
    ("first", 5),
    ("second", 3)
)
```

## Assignment

```typescript
// Immutable assignment
let x = 5

// Mutable assignment
var y = 7
```

## Blocks

In dream a block is a group of statements with the same level of indentation.

```
// Top Level Blocl
let x = 3
let y = 4
if x < y:
    // Second level block
    print("Hello!")
    print("x is less than y")
```

Blocks evaluate to the result of their last expression.

```
let four =
    let a = 2
    let b = 2
    a + b
```

## If expressions

```
if expr: do_work()

if expr: do_work()
else: dont_do_work()

if expr:
    do_work()
    andSomeOtherThing()
elif other_test:
    do_something_else()
else:
    dont_do_work()

// Ifs are expressions that can return a value
let four =
    if 3 > 2: 4
    else: 2
```

## Loops

```
for item in iterator: doWorkOnItem(item)

while expr:
    doWork()
    doOtherWork()
```

## Match Statements (TODO)

## Functions

```
let add = (a: Int, b: Int) -> Int => a + b

// Return can usually be inferred
let add = (a: Int, b: Int) => a + b

let multiline = () =>
    do_this()
    and_that()
    5

// Calling
let four = add(2, 2)
multiline()
```

## Methods

```
// Basic definition
def add(a: Int, b: Int) -> Int = a + b

// Can be overloaded
def do_work(on: Array) -> void = on.uppercase()
def do_work(on: String) -> void = on.lowercase()

// Parameters are labeled on call
do_work(on: my_array)
let four = add(a: 2, b: 3)
```

## Enums

```
enum Direction =
    case North
    case East
    case South
    case West

enum Direction =
    // cases can be condensed to one line
    case North, East, South, West

// Supports swift dot notation (I.E. if the enum can be infered, it's name can be omitted)
let direction: Direction = .North

// Associated value
enum NumsOrString =
    case Str(String),
    case Nums(Int, Int, Int)


let nums: NumsOrString = .Nums(3, 2, 1)
```

## Optionals

```typescript
def div(a: Int, b: Int): Option[Int] => {
    if b == 0 { return .None }
    .Some(a / b)
}

// If the value is .Some, execute the block
if let two = div(4, 2) {
    print("4 / 2 is 2!")
}

def do_work() => {
    guard let two = div(2, 0) else {
        print("Two does not equal 2 / 0")
        return
    }
    print("Two equals 2 / 0")
}
```

## Structs

```
struct Vector3D =
    var x, y, z: Double


// Structs can be extended
extension Vector3D =
    def get_squared_length(): Double = x * x + y * y + z * z
    def get_length(): Double = sqrt(get_squared_length())

    // Methods that mutate the value of the struct should be marked as mutating
    mutating def make_unit_vector() =
        let k = 1.0 / length
        x *= k
        y *= k
        z *= k

    // Methods can be overloaded
    mutatating def apply(x: Double) = self.x = x
    mutatating def apply(y: Double) = self.y = x
    mutatating def apply(z: Double) = self.z = x
}

// Computed properites
extension Vector3D =
    // Computed properties (getter only)
    get squared_length: Double = get_squared_length()
    get length: Double = get_length()

    // Computed property (with getter and setter)
    get x_alias: Double = x
    set x_alias(v: Doble) => x = v

/* Usage */

// Create an instance
let my_vec = Vector3D(x: 4, y: 3, z: 2)

my_vec.make_unit_vector()

let length = my_vec.length
```

## Generics

```
def add[T](a: T, b: T): T = a + b

struct RGB[T] =
    var r, g, b: T

    def init(r: T, g: T, b: T) = // ETC
```

## Protocols

```
protocol HasMath =
    def add(a: Int, b: Int) -> Int
    def sub(a: Int, b: Int) -> Int

// Implementing the protocol
struct MyStruct: HasAdd =
    def add(a: Int, b: Int): Int => a + b
    def sub(a: Int, b: Int): Int => a - b

```

## Sugar

```
// Variadic parameters and splatting
let make_array = (nums: ...Int) => Array(...nums)

// Tuple destrucuring
let (a, b) = (3, 2)

// Ignoring values in tuple destructuring
let (_, b) = (3, 2)

// Struct destructuring
let { x, y } = my_vec

// Struct splatting
let another_vec = Vector3D { ...new_vec, x: 3 }

// Unlabled method parameters
def my_method(_ not_labled: Int, labled: Int) = // ETC

my_method(5, labled: 6)

// Parameter label alias
def add(a x: Int, b y: Int): Int => x + y
add(a: 5, b: 3)

// async / await
async def request(url: String) = await net.request(:url)

// Apply
func()  // shorthand for func.apply()

// Single argument application
func~ 3 // Short for func(3)

// Single argument application usage example
let doubledAgesOfBrownMammals = animals
    .filter~ animals => animals.type == "Mammals"
    .filter~ animals => animals.color == "Brown"
    .map~ animals =>
        // Multiline example
        let age = animals.age
        age * 2
```
