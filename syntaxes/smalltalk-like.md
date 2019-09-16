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

"**Objects**"
object Point =
    var x, y, z: Int

    def squared =
        Point {
            x: x squared,
            y: y squared,
            z: z squared
        }

let p1 = Point x: 1 y: 2 z: 3
let p2 = p1 squared
```

# Messages

Messages are commands sent to an object.

Messages have 3 types:
1. Unary.
2. Binary.
3. Keyword.


Examples:
```
"Unary"
engine start "Send the message 'start' to the engine object'"

"Binary"
1 + 2 "Send the message + 2 to 1"

"Keyword"
my_numeric_list push: 7 "Send the message push: 7 to the my_numeric_list object"

"
Keyword messages can have more than one keyword.
In this case, the message is `insert:atIndex:`.
"
my_numeric_list insert: 2 atIndex: 0
```

A unary message doesnt always have to be a word. It can also take the form
of a parenthetical list, or an anonymous object.

Examples:
```
"Send the message (1, 2) to the add object"
add(1, 2)

"Send the message () to the do_work object"
do_work()

"Some more examples"
double(3)
unit_vector_from { x: 1, y: 3, z: 7 }
```

# Expressions

Expressions are parsed with the same rules as smalltalk. unary messages > binary messages > keyword.
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

In dream expressions and statements are usually terminated by a newline. However, if the next line
is indented an additional level and is a message send, the message is sent to the result of
the previous expression. This enables elegant use of functional patterns.

For example:
```
let nums = List(2, 1, 4)

let result = nums
    map: fn(num) =
        num * 2
    sort: fn(n1, n2) =
        n1 > n2
    withAccumulater: 0 reduce: fn(acc, next) =
        acc + next

print(result) "256"
```

# Functions

A function is an object that understands a single message.

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

fn triple[T Numeric](n T) = n * 3

fn add nums: n1 Int, n2 Int with: n3 =
    n1 + n2 + n3

fn shift_point_by_2 { x: Int, y: Int } -> { x: Int, y: Int } =
    { x: x + 2, y: y + 2 }

let my_anon_func = fn(x) = x * 3

hi "Result: Hi!"
double(2) "Result: 4"
triple(4.0) "Result: 16.0"
add nums: 1, 2 with: 3 "Result: 6"
shift_point_by_2 { x: 2, y: 2 } "Result: { x: 4, y: 4 }"
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
objects Point =
    let x, y: Int

    "
    Like swift structs, objects in dream have initializers that are defined automatically.
    But can be defined explicitly too.
    "
    init x: Int y: Int =
        Point { x, y }

    def squared =
        Point
            "Members of the object can be accessed with self"
            x: self x squared
            "If there are no conflicting names in the same scope, self can be omitted
            y: y squared

    "Methods that mutate the object must be marked with mut"
    mut def square =
        x = x squared
        y = y squared
```

# Enums

Basic definition
```
enum Signal =
    case FM
    case AM
```

Enums can have associated values
```
enum Signal =
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
trait Pointable =
    var x, y: Int

    def squared -> Pointable

    "Interfaces support default implementations"
    mut def square =
        x = x squared
        y = y squared

object Point =
    var x, y: Int

impl Pointable for Point =
    def squared = Point x: x squared y: squared
```

# Uniform Function Call Syntax

Dream supports Uniform Function Call Syntax (UFCS). This allows free standing functions to be called
on objects as if they were methods of the object.

```
fn double(n Int) = n * n

"Both of the following are valid uses of the double fn."
double(3)
3 double
```

The lookup rules for UFCS are simple. To resolve `Object message`, the compiler will:

1. Check `Object` for a `message` fn. If so, use it.
2. Check the current scope for an object with the name `message`
   that can take the message `(Obect)`. If one exists, use it.
3. If both 1 and 2 failed, Error.

Some more examples:
```
"UFCS also works with functions that take more than one argument"
fn map(list List[Int], callback Fn(item Int) -> Int) =
    var new_list = List[Int] new
    list forEach: fn(item) =
        new_list push: callback(item)

let my_list = List(1, 2, 3)
let my_doubled_list = my_list map(fn(item) = item * 2)

"
If there is only two arguments in a function, the function can also be
called like a keyword message. So the following is also valid.
"
let my_other_doubled_list = my_list map: fn(item) = item * 2
```
