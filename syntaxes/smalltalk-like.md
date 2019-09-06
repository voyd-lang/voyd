# Dream Lang With SmallTalk Like Syntax

This is a new idea for dream that combines ideas from smalltalk, python, rust, and
scala.

Features:
    - Indentation significant syntax
    - Message passing (ala smalltalk)
    - Object and functional oriented
    - Static typing (with type inference)

# Overview

```
"Comments in quotes"

"**Types**"

1 "Int"
1.0 "Double"
`Hello` "String"
false "Boolean false"
trye "Boolean true
(1, 2, 3) "Tuple"
{ a: 1, b: 2, c: 3 } "Anonymous object"

"**Variables**"

"Immutable"
let x = 3

"Mutable"
var y = 2

"**Functions**"
fn double(i Int) = i * 2
fn fib(n Int) -> Int =
    if n <= 1: return n
    fib(n - 1) + fib(n - 2)

"**Structs**"
struct Point:
    var x, y, z: Int

    def squared =
        Point
            x: x squared
            y: y squared
            z: z squared

let p1 = Point x: 1 y: 2 z: 3
let p2 = p1 squared
```

# Messages

Messages are commands sent to an object.

Messages have 5 types:
1. Unary
2. Binary
3. Keyword
4. Parenthetical list
5. Anonymous object

Examples:
```
"Unary"
engine start

"Binary"
1 + 2

"Keyword"
my_numeric_list push: 7

"Keyword with multiple arguments"
my_numeric_list insert: 2 atIndex: 0

"Parenthetical list"
add(1, 2)
do_work()
log("hello")

"Anonymous object"
square_vector { x: 3, y: 2, z: 1 }
```

# Expressions

Expressions are parsed with the same rules as smalltalk. Parenthetical list, anonymous object, and unary messages > binary messages > keyoword
messages.

Examples:
```
"Unary message:"
'Hello' uppercase

"Binary message:"
3 + 4

"Keyword message"
'This is a sentence' sliceFrom: 3 to: 4

"The following expression:"
5 double + 6 triple between: 5 and: 300
"Evals to:"
10 + 18 betweeen: 5 and: 300
"Then:"
28 between: 5 and: 300
"Finally:"
true
```

# Functions

A function is an object that accepts a single message. This message can be a tuple,
object, or keyword.

```
fn name [Generics...] message -> ReturnType =
    Function Body
```

The `[Generics...]` section is optional. There can be multiple messages.
`-> ReturnType` can usually be infered so that can also be left out.

Examples:
```
fn hi = print: "Hi!"

fn double(i Int) = i * 2
fn double = i * 2

fn triple[T Numeric](n T) = n * 3

fn add nums: n1 Int, n2 Int with: n3 =
    n1 + n2 + n3



fn quadruple(i: Int) -> Int = i * 4

fn square_point { x: Int, y: Int } -> { x: Int, y: Int } =
    { x: x squared, y: y squared }

let my_anon_func = fn(x) = x * 3

hi "Result: Hi!"
double: 2 "Result: 4"
double: 3.0 "Result: 6.0"
4 triple "Result: 12"
add nums: 1, 2 with: 3 "Result: 6"
quadruple(3) "Result: 12"
square_point { x: 2, y: 2 } "Result: { x: 4, y: 4 }"
my_anon_func: 3 "Result: 9"
```

# Control flow

```
if 3 > 2:
    print: '3 > 2'

for num in (1 to: 4):
    print: num

match num:
    case 1: "One"
    case 2: "Two"
    default: "A number"
```

Dream supports expression oriented control flow. If, match, and loop constructs are all
expressions that can return a value.

```
let my_string = if 3 > 2:
    "3 > 2"
else:
    "3 is somehow less than 2"

let my_num = for num in (1 to: 4):
    if num > 2: break num
default: "Garuntees that the for loop returns a value"
    0

let number = match num:
    case 1: "One"
    case 2: "Two"
    default: "A number"
```

# Structs

```
struct Point:
    let x, y: Int

    "
    Like swift structs, initializers are defined automatically.
    But can be defined explicitly too.
    "
    init x: Int y: Int =
        Point x: x y: y

    def squared =
        Point
            "Members of the struct can be accessed with self"
            x: self x squared
            "If there are no conflicting names in the same scope, self can be omitted
            y: y squared

    "Functions that mutate the struct must be marked with mut"
    mut def square =
        x = x squared
        y = y squared
```

# Enums

Basic definition
```
enum Signal:
    case FM
    case AM
```

Enums can have associated values
```
enum Signal:
    case FM(Double)
    case AM(Double)

let station = Signal FM(91.5)

if let Signal FM(channel) = station:
    print: 'The FM channel is $(channel)'
if let Signal AM(channel) = station:
    print: 'The AM channel is $(channel)'
```

# Traits

```
trait Pointable:
    var x, y: Int

    fn squared -> Pointable

    "Interfaces support default implementations"
    mut fn square =
        x = x squared
        y = y squared

struct Point:
    impl Pointable
    var x, y: Int

    fn squared = Point x: x squared y: squared
```

# Uniform Function Call Syntax

Dream supports Uniform Function Call Syntax (UFCS). This allows free standing functions to be called
on objects as if they were methods of the object.

```
fn double: n Int = n * n

"Both of the following are valid uses of the double fn."
double: 3
3 double

fn add: n1 Int, n2 Int = n1 + n2

"All of the following are valid uses of the sum fn."
add: 1, 3
1 add: 3
1 add(3)
```

The lookup rules for UFCS are simple. To resolve `Object message`, the compiler will:

1. Check `Object` for a `message` fn. If so, use it.
2. Check the current scope for a `message: Object` fn. If so, use it.
3. Error.
