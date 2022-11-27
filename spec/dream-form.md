# Symbol

Symbols in dream are a sequence of characters that can have different purposes depending on
the context. For most user applications symbols are used to name things. They can also be interpreted
by macros to modify their behavior. Its also possible in some cases to treat them as strings at
runtime.

Symbols in dream follow the same rules as symbols in lisp with a few modifications:

- A symbol can only contain one `<` character, and that `<` character must be the first character
  if it is present.
- A symbol cannot contain a `.`
- `@ & ~` are reserved for future use
- Scientific E notation is interpreted as a number
- Strings are not symbols i.e. `"i am a string"`
- Symbols beginning with a `#` denote a reader macro
- `? !` are treated as alphanumeric along with `+ - \* / $ % ^ \_ = >`
- When an infix operator symbol is between two expressions within a block, it is interpreted as an
  infix operation automatically. Infix operators are ` + - / * == < > >= <= => |> | ^ % and or xor ||`
- Dream is case sensitive
- A single equal sign is NOT an operator. It is typically used as a visual separator in assignment operations. (Maybe it should be considered synonymous with \n\t)

## Grammar

```ebnf
Symbol = !Number FirstSymbolChar Alphanumeric*;
FirstSymbolChar = "<" | Alphanumeric;
Alphanumeric = #'[^\s\(\)\[\]\{\}<@&]';
```

# Number

## Grammar

```ebnf
Number = ScientificNumber | Int | Float;
ScientificNumber = #'^[+-]?\d(\.\d+)?[Ee][+-]?\d+$';
Int = #'^[+-]?\d+$';
Float = #'^[+-]?\d+\.\d+$';
```
