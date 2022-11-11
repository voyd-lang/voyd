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
(func (generic T) a b)
```

## Transformation Rules

1. Any atom followed immediately by a by a `<` swaps positions with each other, converts the `<` to `(`, and adds `(generic`. `func<` -> `(func (generic `
2. Any instance of `>(` is replaced with `)`. `>(` -> `)`.
