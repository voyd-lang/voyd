
# Keywords

let, var, if, else, elif, for, while, loop, break, continue, return, match, enum, struct, impl,
trait, sized, type, fn, static, true, false, as, self, pub, use, import, from, with, move, owned,
boolean, i32, i64, i8, i16, u32, u64, u8, u64, u16, f32, f64, strict, unsafe, mut, void

# Operators

The following are all treated as infix operators:
+, -, *, /, %, &, ^, <<, >>, ==, !=, <, <=, >, >=, and, or, =, +=, -=, *=, /=, %=, &=, |=,
^=, <<=, >>=, |>

Prefix:
not, !, ~

Note that all operators can be overridden.

# Symbols

The following are reserved for various language constructs (some may be removed, no additional will
be added):

#, @, //, /*, */, #!, &, :, :>, :<, ::, ::=, ::<, ::<=, ::>=, ::>, $, %

# Notes:

- `strict` may be used to mark a function that is guaranteed to not have any side effects. Non
strict functions have some implicit side effects such as `print`.
