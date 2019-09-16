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

Messages have take five forms:
1. Unary.
2. Binary.
3. Keyword.
4. Tuple.
5. Anonymous Object,


## Unary Messages

Unary messages are messages sent to a single object with no additional context.

Examples:
```
engine start "Send the message 'start' to the engine object"
door open "Send the message 'open' to the door object"
```

## Binary Messages

Binary messages are messages that start with an operator character and have one argument.

Examples:
```
1 + 2 "Send the message '+' with the argument '2' to the object '1'"
3 / 4
`Hello,` + ` World!`
```

## Keyword Messages

Keyword messages are messages that can have one or more arguments.

They look like this:
```
Object message: parameter
```

Keyword messages can have an unlimited number of arguments. But each argument is identified
by a keyword:
```
Object keyword1: parameter1 keyword2: parameter2 "...etc"
```

Examples
```
`Hello, World!` indexOf: `o` startingAt: 5 "Returns 8"
MyList append: 5
```

## Tuple Messages

Tuple messages are a parenthetical list of up to an unlimited number of arguments.

Example:
```
add(1, 2) "Send the message (1, 2) to the add object
```

## Anonymous Object Messages

Anonymous object messages are a lot like keyword messages. They key difference is that they are wrapped
in curly braces `{}` and are comma seperated. This allows you to spread the message accross
multiple lines.

```
let point = Point {
    x: 1 * 2,
    y: 3 raisedBy: 5,
    z: 5 + 4
}
```

Object messages have another neat feature. If the keyword is being set to a variable that
shares the same name as the keyword, you can omit the variable.

For example:
```
let x = 1
let y = 4

"Instead of doint this"
Point { x: x, y: y, z: 4 }

"You can do this!"
Point { x, y, z: 4 }
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

Objects are self contained units that can store information and react to messages.

```
objects Point =
    let x, y: Int

    "
    Like swift structs, objects in dream have initializers that are defined automatically.
    But can be defined explicitly too.
    "
    init x: Int y: Int =
        Point { x, y }

    "Unary message handler"
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

## Object Methods

Methods allow objects to respond to messages.

In general, they take the form
```
def message -> ReturnType =
    "Method body"
```

Methods always return the result of the last expression in the method body.
But, if you need to return early, the `return` keyword is still available.

Unary message handlers take the form:
```
def message =
    "method body"
```

Binary message handlers take the form:
```
def operator parmaeter: ParameterType =
    "method body"

"i.e."
def + num: Int =
    "method body"
```

Keyword message handlers take the form:
```
def message parmaeter: ParameterType =
    "method body"
```

If the message and parameter share the same name, the parameter portion can be omitted.
For example:
```
"this"
def x x: Int =
    "method body"

"is equivalent to this"
def x: Int =
    "method body"
```

Tuple message handlers take the form:
```
def (parameter: ParameterType) =
    "method body"
```

Object message handlers take the form:
```
def { parameter: ParameterType } =
    "method body"
```

If a method contains only one expression, it can be placed directly after the `=`.
For example:
```
def short_method = 1 * 2
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
    def squared = Point { x: x squared y: squared }
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
