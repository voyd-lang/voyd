# Strings

Strings are a sequence of characters. The main string type, `String`, is can grow and shrink in size when defined as a mutable variable.

Type: `String`

```

```

# Atoms

Atoms are literals who's type and value are equivalent to their given name. They are useful for defining a set of unique values.

```
let my_atom: @my_atom = @my_atom
let my_atom2 = @my_atom
let other_atom = @other_atom

my_atom == my_atom2 // true
my_atom == other_atom // false
```

Atoms with spaces in their can be defined using the `@` prefix and single quotes.

```
let my_atom = @'my atom'
```

# Unions

Unions represent a type that can be one of a set of other types.

A union type is defined by listing the types it can be separated by `|`.

```
type MyResult = @ok | @error

type MyOptionalInt = @some[i32] | @none
```
