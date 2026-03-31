---
order: 120
---

# Guidelines

This page covers style guidance, not language semantics.

## Naming

- UpperCamelCase for types, traits, effects, and components
- snake_case for functions, variables, and files
- Capitalize acronyms as words (`HtmlElement`, not `HTMLElement`)

## API design

- Prefer simple names over type-encoded names.
- Use labels when they make roles clearer, especially once an API has more than
  two non-`self` parameters.
- Use overloads only when the declarations represent the same conceptual
  operation.
- Prefer ordinary functions to macros when both express the same idea.

```voyd
clamp(7, min: 1, max: 5)
records.contains(where: (record) => record.active)
```

## API docs

- Document the canonical operation, not every forwarding overload.
- Give one primary doc block to each conceptual API family.
- Thin overloads may omit docs entirely or use a one-line redirect.
- Use doc comments for semantics, failure behavior, ownership/performance
  caveats, and recommended usage.
- Keep examples on the preferred public spelling rather than compatibility
  helpers or aliases.

## Effects

For public effects, use stable dotted ids.

```voyd
@effect(id: "voyd.std.fs")
eff Fs
```
