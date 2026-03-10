---
order: 90
---

# Doc Comments

Voyd supports Markdown doc comments on modules, declarations, members, and
function parameters.

## Forms

```voyd
/// Outer doc comment
//! Inner module doc comment
// Regular comment
```

## `///` outer docs

`///` attaches to the next documentable declaration when there is no blank line
between the docs and the target.

```voyd
/// Builds a user profile.
fn build_profile(user: User) -> Profile
  todo()
```

Supported targets include:

- `fn`
- `obj`
- `type`
- `trait`
- `impl`
- `mod`
- module-level `let`
- object, trait, and impl members
- macros

## `//!` inner docs

`//!` documents the enclosing file or inline module.

```voyd
//! HTTP helpers.
//! Shared request/response types.
```

## Parameter docs

Inside parameter lists, `///` attaches to the next parameter entry.

```voyd
/// Sends a request.
fn send(
  /// Endpoint URL.
  url: String,
  {
    /// Timeout in milliseconds.
    timeout_ms: i32
  }
) -> Response
  todo()
```

## Attachment errors

Doc comments that do not attach to a valid target produce diagnostics. A blank
line between a `///` block and its target also breaks attachment.

## Tooling

- Hover, completion, and signature help consume doc comments.
- `voyd doc` renders HTML or JSON API documentation.

See [CLI](./cli.md) for documentation command examples.
