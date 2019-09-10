
"Comments in quotes"

"**Types**"

1 "Int"
1.0 "Double"
`Hello` "String"
false "Boolean false"
true "Boolean true"
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
