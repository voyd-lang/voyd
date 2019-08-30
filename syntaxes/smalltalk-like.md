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
{ 1, 2, 3 } "Array"
{ a: 1, b: 2, c: 3 } "Anonymous object"

"**Variables**"

"Immutable"
let x = 3

"Mutable"
var y = 2

"**Functions**"
fn double: i Int = i * 2
fn fib: n Int -> Int =
    if n <= 1: return n
    fib: n - 1 + fib: n - 2

"**Objects**"
object Point:
    var x, y, z: Int

    fn squared =
        Point
            x: x squared
            y: y squared
            z: z squared

let p1 = Point x: 1 y: 2 z: 3
let p2 = p1 squared
```

# Expressions

Expressions are parsed with the same rules as smalltalk. Unary messages > Binary messages > Keyoword
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

Functions can take three forms. Message, destructured tuple, and destructured object form.

Message form:
```
fn [Type] (reciever RecieverType) message: param ParamType -> ReturnType =
    Function Body
```

`[Type]` and `(reciever RecieverType)` are optional. There can be multiple messages. If the
function needs no arguments the `: param ParamType` can also be left out. In general the
`-> ReturnType` can usually be infered so that can also be left out.

Destructured tuple form:
```
fn [Type] (reciver RecieverType) name(param ParamType) -> ReturnType =
    Function body
```

Destructured object form:
```
fn [Type] (reciver RecieverType) name { param: ParamType } -> ReturnType =
```

Examples:
```
fn hi = print: "Hi!"

fn double: i Int = i * 2

fn [T Multiplyable] double: i T = i * 2

fn (i Int) triple =
    i * 3

fn add: n1 Int and: n2 Int =
    n1 + n2

fn quadruple(i: Int) -> Int = i * 4

fn square_point { x: Int, y: Int } -> { x: Int, y: Int } =
    { x: x squared, y: y squared }

let my_anon_func = fn(x) = x * 3

hi "Result: Hi!"
double: 2 "Result: 4"
double: 3.0 "Result: 6.0"
4 triple "Result: 12"
add: 3 and: 4 "Result: 7"
quadruple(3) "Result: 12"
square_point { x: 2, y: 2 } "Result: { x: 4, y: 4 }"
my_anon_func(3) "Result: 9"
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

# Objects

```
object Point:
    let x, y: Int

    "
    Like swift structs, initializers are defined automatically.
    But can be defined explicitly too.
    "
    init x: Int y: Int =
        Point x: x y: y

    fn squared =
        Point
            "Members of the object can be accessed with self"
            x: self x squared
            "If there are no conflicting names in the same scope, self can be omitted
            y: y squared

    "Functions that mutate the object must be marked with mut"
    mut fn square =
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

# Interfaces

```
interface Pointable:
    var x, y: Int

    fn squared -> Pointable

    "Interfaces support default implementations"
    mut fn square =
        x = x squared
        y = y squared

object Point(Pointable):
    var x, y: Int

    fn squared = Point x: x squared y: squared
```
