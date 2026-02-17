# Doc Comments

Voyd supports line-based doc comments for declarations, modules, files, and function parameters.
Doc comments are Markdown consumed by tooling (language server and docs generation).

## Comment Forms

```voyd
/// Outer doc comment (attaches to next documentable target)
//! Inner doc comment (attaches to enclosing file or module)
// Regular comment (not documentation)
```

## Documentable Targets

Doc comments may attach to:

- `obj`, `type`, `trait`, `impl`, `fn`, and `mod` declarations
- members of `obj`, `trait`, and `impl` blocks
- function parameters (including labeled parameters and externally-labeled parameters)
- file/module docs via `//!`

Doc comments do not attach to `let`, `var`, statements, expressions, or local-only constructs.

## Outer Docs (`///`)

`///` attaches to the next documentable declaration when:

1. It appears immediately before the declaration.
2. Only whitespace and regular `//` comments appear in between.
3. There is no blank line between the doc block and the declaration.

Multiple consecutive `///` lines are concatenated in source order. An empty `///` line becomes a blank line in the resulting docs.

```voyd
/// A 2D vector.
obj Vec2 { x: Float, y: Float }

/// Adds two values.
fn add(a: i32, b: i32) -> i32
  a + b
```

## Inner Docs (`//!`)

`//!` always attaches to the enclosing container:

- at top level, it documents the file/module
- inside a `mod` body, it documents that module

```voyd
//! Math utilities.
//! Prefer importing `math`.
```

## Parameter Docs

Inside a function parameter list, `///` attaches to the next parameter entry.
This includes positional parameters and entries inside labeled-parameter objects.

```voyd
/// Does foo.
fn foo(
  /// Positional parameter docs.
  bar: Type,
  {
    /// Labeled parameter docs.
    baz: Type,

    /// Docs attach to `param`, not to external label token.
    ext_label param: Type
  }
) -> ReturnType
  todo()
```

Parameter docs only apply to parameters, not to the containing function.

## Attachment Breaks and Errors

A blank line between a `///` block and its target breaks attachment and causes a dangling-doc error.
Doc comments before non-documentable targets (for example `let` or `var`) also produce errors.

```voyd
/// I am dangling.

fn ok() -> i32
  1
```

```voyd
/// Invalid target.
let x = 1
```

## Markdown and Tooling

- Doc text is Markdown and preserved as written (line endings normalized to `\n`).
- Hover shows symbol docs as Markdown.
- Signature help may show function and active-parameter docs.
- Completion entries may include short doc summaries.

## HTML Docs CLI

Use the docs command to generate a single self-contained HTML file:

```bash
voyd doc
voyd doc --out docs.html
```

The output includes a title, table of contents, stable anchors, public documented items, signatures, and rendered Markdown docs.
