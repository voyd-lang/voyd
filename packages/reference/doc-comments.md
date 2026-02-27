# Doc Comments

Voyd supports Markdown doc comments on declarations, modules/files, and function parameters.
Tooling (language server and docs generation) reads these comments directly.

## Comment Forms

```voyd
/// Outer docs: attach to the next documentable declaration
//! Inner docs: attach to the enclosing file or module
// Regular comment: not documentation
```

## Documentable Targets

Doc comments can attach to:

- `obj`, `type`, `trait`, `impl`, `fn`, and `mod` declarations
- members inside `obj`, `trait`, and `impl` blocks
- function parameters (including labeled and externally-labeled parameters)
- file/module docs via `//!`

Doc comments do not attach to `let`, `var`, statements, expressions, or local-only constructs.

## Outer Docs (`///`)

`///` attaches to the next documentable target when:

1. It is immediately before that target.
2. Only whitespace and regular `//` comments appear in between.
3. There is no blank line between the final `///` line and the target.

### Multiline `///` blocks

Consecutive `///` lines are combined in order.
Use `///` by itself to produce a blank paragraph line.

```voyd
/// Builds a user profile.
///
/// Includes computed display metadata.
fn build_profile(user: User) -> Profile
  todo()
```

## Inner Docs (`//!`)

`//!` always documents the enclosing container:

- at top level: the file/module itself
- inside a `mod` body: that nested module

### Multiline `//!` blocks

Consecutive `//!` lines are combined in order.
Use `//!` by itself to create paragraph spacing.

```voyd
//! HTTP helpers.
//!
//! Shared parsing and formatting utilities.

mod http
```

```voyd
mod http
  //! Request/response value types.
  //!
  //! Re-exported by `std::http`.
```

## Parameter Docs

Inside a function parameter list, `///` attaches to the next parameter entry.
Parameter docs document that parameter only, not the function.

### Placement rules

- Place the `///` line directly above the parameter it describes.
- For labeled parameter objects, place docs above each field entry.
- For externally-labeled parameters, attach docs above the full entry (`label param: Type`).

```voyd
/// Sends a request.
fn send(
  /// Endpoint URL.
  url: String,
  {
    /// Request timeout in milliseconds.
    timeout_ms: i32,

    /// Docs apply to the parameter entry, including its external label.
    with_headers headers: Dict<String, String>
  }
) -> Response
  todo()
```

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
- Signature help may show function docs and active-parameter docs.
- Completion entries may include short doc summaries.

## HTML Docs CLI

Use the docs command to generate a single self-contained HTML file:

```bash
voyd doc
voyd doc --out docs.html
```

The output includes a title, table of contents, stable anchors, public documented items, signatures, and rendered Markdown docs.
