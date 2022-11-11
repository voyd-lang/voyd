# Dream Overview

Dream is a high performance, high level applications language
with an emphasis on full stack web development.

Dream uses a hybrid lisp syntax designed to balance the benefits of data-as-code with the familiarity of C style programming languages.

Dream compiles to WASM.

## Comments

```
; Comments are single line and are marked with a semi-colon
```

## Primitive Types

```
true ; Boolean
false ; Boolean
1 ; i32 by default (32 bit integer)
1.0 ; f32 by default (32 bit float)
"Hello!" ; String, can be multiline, supports interpolation via ${}
[1 2 3] ; Tuple
{x: 2 y: 4} ; Struct literal
$[1 2 3] ; Array
${x: 3 y: 4} ; Dictionary / Hash Table / Object
```

## Variables

```
; Immutable variable
let my-immutable-var = 7

; Mutable variable
var my-var = 7
```

## Functions

A Basic function:

```
fn add(a: i32 b: i32) -> i32
  a + b
```

In most cases the return type can be inferred

```
fn add(a: i32 b: i32)
  a + b
```

Functions are called using S-expression syntax

```
(add 1 2) ; 3
```

Dream uses significant indentation like [sweat](https://dwheeler.com/readable/sweet-expressions.html). So the parenthesis can be omitted provided its the only expression on it's line and is properly indented

```
add 1 2
```

Dream can also call functions in the more standard mathematical notation. Note that there cannot be whitespace separating the function name from the opening parenthesis

```
add(1 2)
```

## Infix Notation

Dream supports infix notation on a fixed list of operators. Infix operators must be separated by whitespace on each side.

Operators include:

- `+`
- `-`
- `*`
- `/`
- `<`
- `>`
- `<=`
- `>=`
- `^`
- `=` Assignment
- `+=` Assignment
- `-=` Assignment
- `*=` Assignment
- `/=` Assignment
- `==` Comparison

## Control flow

### If statements

```
if 3 < val
  "hello" ; true case
  "bye" ; false case (optional)
```

Ifs are expressions that return a value

```
let x = (if 3 < val "hello" "bye")
```

### Loops

Basic loops repeat until returned from

```
var a = 0
loop
  if a > 10
    return a
  a += 1
```

Loops can be named

```
var a = 0
loop :named increment
  if a > 10
    return-from increment a
  a += 1
```

Useful constructs from looping through iterables

```
for item in iterable
  write item
```

### Match Statements

```
let x = 3
match x
  1 (write "One")
  2 (write "Two")
  3 (write "Three")
  default
    ; Match statements are exhaustive, they must cover every possible
    ; case. When not every case is covered, a default handler must be
    ; provided.
    write "A number"
```

## Lambdas

```
let double = n => n * 2

array.map n => n * 2
```

## Dot Notation

The dot is a simple form of syntactic sugar

```
let x = 4

x.squared

; Translates to
squared x ; (squared x)
```

## Keyword Arguments

Any arguments that are listed after the `~` are keyword arguments.

```
fn move(robot:Robot ~ to:(i32 i32 i32))

move robot to: (3.1, 2.3, 4.0)
```

You can also provide an external label to alias the keyword on call.

```
fn add(a:i32 ~ with:b:i32)
  a + b

add 1 with: 4
```

## Generics

Generics are defined using angle brackets. Note: there must not be any
spaces between the function name and open parenthesis of a function call.

```
fn add<T>(a:T b:T) -> T
  a + b
```

With trait constraints

```
fn add(type T:Numeric)(a:T b:T) -> T
  a + b
```
