# A New Syntax Proposal

For the millionth time, I think I want to change the syntax.

This new syntax is inspired by swift, rust, ruby, python and now lua.
Emphasis on ruby and lua.

# Comments

```
# This is a comment
```

# Types
```
true // Boolean
false // Boolean
1 // Int
1.0 // Double
"Hello!" // String, can be multiline, supports interpolation via ${}
(1, 2, 3) // Tuple
{x: 2, y: 4} // Anonymous struct
$(1, 2, 3) // Array
${x: 3} // Dictionary
```

# Variables

```
# Immutable var
let x = 7

# Mutable var
var y = 3
```

# Blocks
Standard block evaluated once.
```
block
    print("hello world!")
end
```

Blocks generally start with a `\n` or a `:` for single line blocks and can be terminated by an `end` or a `;`.

In general `end` should be used for multi-line blocks while `;` should be
used for single expression, one line blocks.

# Control Flow

**Ifs**
```
if 3 > val

elif 3 < val

else

end

# Ifs can be used like a ternary, note `:` is required for single line ifs
let three = if 4 > 5: 2 else 3;
```

**Loops**
```
for item in iterable

end

while condition

end
```

**Match statements**
```
let x = 3
match x
    case 1: print("One");
    case 2: print("two");
    case 3: print("three");
    case _
        # Match statements must cover every possible case.
        # _ means default. I.E. if no other patterns match, use this one.
        print("A number")
    end
end
```

# Functions

```
# A basic function
fn add(a: i32, b: i32) -> i32
    a + b
end

# In most cases the return type can be inferred.
fn add(a: i32, b: i32)
    a + b
end

# Single expression functions can be neatly written on one line
fn add(a: i32, b: i32): a + b;
```

# Expression Oriented

Dream is an expression oriented language. Blocks, Ifs, and Matches all return a value, that is
the result of the last expression in their group. Functions will also implicitly return the
value of the last expression in their body (Unless it's return type is explicitly set to Void).

Examples:
```
let three = if true: 3 else 4;

let fred = match "Smith"
    case "Jobs": "Steve";
    case "Smith": "Fred";
    case "Gates": "Bill";
    case _: "Unknown";
end

fn work(a: Int)
    let b = a * 2
    b + 3
end

let five = work(1)
```

# Structs

```
struct Target
    let x, y, z: Int
end

let target = Target { x: 4, y: 5, z: 3 }

// Anonymous struct.
let point = { x: 5, y: 3 }

// Destructuring
let { x, y } = point;
log(x) // 5
log(y) // 3

// If an identifier has the same name as a struct field, the field label can be omitted.
let x = 5
let dot = {x} // Equivalent to {x: x}
```

# Generics

Functions:
```
fn add[T](a: T, b: T) -> T
    a + b
end

add[i32](1, 2)

// With type inference
add(1, 2)
```

Structs
```
struct Target[T] {
    let x, y, z: T

    // Init functions implicitly take on the type parameters of the struct. So
    // the final signature looks like init[T](x: T, y: T, z: T) -> Target[T]
    init(x: T, y: T, z: T) = Target { x, y, z }
}

let t1 = Target[i32](1, 2, 3)

// In this case the above could also be written as follows thanks to type inference.
let t2 = Target(1, 2, 3)
```

# Closures

```
let add = |a: Int, b: Int|: a + b;
```

## Trailing closures

```
get("http://api.example.com/stuff") ||

@fail |error|

end
```
