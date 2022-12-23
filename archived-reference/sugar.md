# Function Definition / Call

This sugar allows dream to understand more standard
mathematical function notation

```
func(a b)
```

Is translated to:

```
(func a b)
```

## Transformation Rules

1. Any atom followed immediately by a `(` swaps positions with each other and adds a space. `func(` -> `(func `

# Generics

This sugar closely mimics the angle bracket based generics syntax of
languages such as TypeScript, Swift, and Rust.

```
func<T>(a b)
```

Is translated to:

```
(func (types T) a b)
```

## Transformation Rules

1. Any atom followed immediately by a by a `<` swaps positions with each other, converts the `<` to `(`, and adds `(generic`. `func<` -> `(func (types `
2. Until the closing `>`, `<` is converted into `(` and `>` is converted to `)`
3. The closing `>` is converted into a `)`

# Struct literals and dictionaries

Simple syntax for defining a struct or a dictionary

```
{
  a: (x * y)
  b: {
    c: func(hello!)
    d: "who is it"
  }
}
```

Is translated to:

```
(struct
  a: (x * y)
  b: (struct
    c: func(hello!)
    d: "who is it"
  )
)
```

```
${
  a: (x * y)
}
```

Is translated to:

```
(dictionary
  a: (x * y)
)
```

Special note:
structs accept both the form `(label: expression)` as well as `label: expression` to as a field definition. This allows for clean formatting
with new lines and tabs while still supporting parenthetical elision.

## Transformation Rules

1. `{` is transformed into `(struct `.
2. `$` is transformed into `(dictionary `.
3. `}` is transformed into `)`
