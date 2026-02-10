# Comments

```voyd
// This is a single line comment
```
# Identifiers

Identifiers bind names to values, types, and other language constructs. They can
contain letters, numbers, and underscores, and must start with a letter or underscore.

```voyd
hey
hey_there
MyType
MyType2
```

# Variables

```voyd
// Declare an immutable variable
let x = 5

// Declare a mutable variable (see note)
var y = 3
```

# String Literals

```voyd
// Strings are defined with double quotes
let name = "John"

// Double quotes also support multi-line strings
let address = "
123 Main St
Anytown, USA
"
// String interpolation will also be supported by double quotes and the ${} syntax (not yet implemented)
let greeting = "Hello, ${name}"
```

# Numeric Literals

```voyd
// Integers
let x = 5

// Floats
let y = 3.14
```

# Boolean Literals

```voyd
let x = true
let y = false
```

# Object literals

```voyd
let value = {
  a: 5,
  b: 4
}

let x = value.a // x will be bound to 5
```

Field shorthand:

```voyd
let a = 5
let value = { a, b: 4 }

// Equivalent to
let value = { a: a, b: 4 }
```

# Tuple literals

```voyd
let value = (5, 4)
let x = value.0 // x will be bound to 5

// Destructuring
let (a, b) = value
```

# Control Flow

```voyd
// If statements
if x > 5 then:
  // Do something
elif: x > 2 then:
  // Do something else
else:
  // Fallback

// While loops
while x > 5 do:
  // Do something

// Case-style while loops
while x > 5:
  // Do something

// For-in loops
for item in [1, 2, 3] do:
  // Do something with item

// Blocks are defined by 2 space indentation
let y =
  let x = 2 + 3
  x + 3 // y will be bound to 8
```
# Expressions

Expressions are statements that return a value. They can be used in a variety of contexts, such as variable assignment, function arguments, and more.

```voyd
// Binary expressions
let x = 5 + 3

// Function calls
let y = add(5, 3)
```

Virtually every statement in Voyd is an expression, including control flow statements.

```voyd
let x = if true then: 1 else: 2

// Blocks are also expressions, returning the result of the last statement
let y =
  let x = 5
  x + 3

// Both z and u will be bound to 5
let z = let u = 5
```
