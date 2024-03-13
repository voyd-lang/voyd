# Comments

```void
// This is a single line comment
```
# Identifiers

Identifiers bind names to values, types, and other language constructs. They can
contain letters, numbers, and underscores, and must start with a letter or underscore.

```void
hey
hey_there
MyType
MyType2
```

# Variables

```void
// Declare an immutable variable
let x = 5

// Declare a mutable variable (see note)
var y = 3
```

# String Literals

```void
// Strings are defined with double quotes
let name = "John"

// Double quotes also support multi-line strings
let address = "
123 Main St
Anytown, USA
"
// String interpolation is also supported by double quotes and the {} syntax
let greeting = "Hello, ${name}"
```

# Numeric Literals

```void
// Integers
let x = 5

// Floats
let y = 3.14
```

# Boolean Literals

```void
let x = true
let y = false
```

# Object literals

```void
let value = {
    a: 5,
    b: 4
}

let x = value.a // x will be bound to 5
```

Field shorthand:

```void
let a = 5
let value = { a, b: 4 }

// Equivalent to
let value = { a: a, b: 4 }
```

# Tuple literals

```void
let value = [5, 4]
let x = value.0 // x will be bound to 5
```

# Control Flow

```void
// If statements
if x > 5 then:
    // Do something
else:
    // Do something else

// When else is not needed both `then:` and `else:` can be omitted
if x > 5
    // Do something

// While loops
while x > 5
    // Do something

// For loops
for i in 0..10
    // Do something

// Blocks*
let y = ${
    let x = 5

    // The result of the block is the result of the last statement, y will be bound to 8
    x + 3
}

// Blocks are implicitly defined by indentation, so this is also valid.
let y =
    let x =
        2 + 3
    x + 3 // y will be bound to 8
```

* The ${} syntax is useful to restore indentation sensitivity in non-indentation sensitive contexts, such as in function arguments, string literals, object literals etc. See the syntax reference for more details.

# Expressions

Expressions are statements that return a value. They can be used in a variety of contexts, such as variable assignment, function arguments, and more.

```void
// Binary expressions
let x = 5 + 3

// Function calls
let y = add(5, 3)
```

Virtually every statement in Void is an expression, including control flow statements.

```void
let x = if true then: 1 else: 2

// Blocks are also expressions, returning the result of the last statement
let y =
    let x = 5
    x + 3

// Both z and u will be bound to 5
let z = let u = 5
```
