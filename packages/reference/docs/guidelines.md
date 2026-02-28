---
order: 120
---

# Voyd Guidelines

## Naming

- UpperCamelCase for types, traits, effects, and components.
- Acronyms should only capitalize the first letter (for example `HtmlElement`).
- snake_case for everything else (including file names).

## Indentation

Two-space indentation. Enforced by the compiler.

## Rules of Thumb

Always prefer obviousness, simplicity, and clarity over cleverness.

- Prefer composition to inheritance. Objects should only extend when they are conceptually interchangeable with their parent.
- Avoid macros when a normal function can express the same behavior.
- Use overloads only when definitions represent the same conceptual operation across different argument shapes/types.
- Avoid overusing effects.

## API Guidelines

### Labeling Guidelines

Use labels intentionally; avoid adding them by default.

- Treat labels as required when a function has more than two non-`self` parameters, unless omitting them is clearly more readable.
- For two non-`self` parameters, prefer labels when they clarify roles or prevent ambiguity.
- Prefer positional parameters when the function name already makes the role obvious.
- Avoid labels that only repeat the same concept already encoded in the function name.
- Use labels to separate overloads when argument shapes or types overlap.

```voyd
// Prefer positional when the name already carries meaning.
queue.push_back(1)

// Prefer labels once an API has 3+ non-self parameters.
clamp(7, min: 1, max: 5)
lerp(0.0, to: 10.0, at: 0.5)

// Prefer shared verb + labels to distinguish overload intent.
dict.contains(key: user_id)
records.contains(where: (record) => record.active)
```

### API Naming Guidelines

Prefer semantic base names over type-encoded names.

- Use labels to describe the source or role of an argument.
- Avoid encoding argument type in the function name when the same concept can be expressed with overloads.

```voyd
// Prefer
ascii_string_from(bytes: source)

// Avoid
ascii_string_from_bytes(source)
```

### String/StringSlice Overloads

For public/api-facing functions:

- If one overload accepts `StringSlice`, provide a corresponding `String` overload with equivalent behavior.
- Prefer a thin forwarding overload so behavior stays consistent and implementation logic stays centralized.

```voyd
pub fn parse(source: StringSlice) -> Result<JsonValue, JsonError>
  parse_impl(source)

pub fn parse(source: String) -> Result<JsonValue, JsonError>
  parse(source.as_slice())
```

### Effect ID Guidelines

Effect IDs are part of your public integration contract. Optimize for long-term stability.

- Use dotted capability IDs: `@effect(id: "<owner>.<package>.<capability>")`.
- Use lowercase ASCII tokens (`a-z0-9` + `.`).
- Treat `capability` as a stable semantic namespace.
- Do not change IDs because of internal refactors (file moves, module renames, or code reorganization).

```voyd
// Stable semantic identity
@effect(id: "voyd.std.fs")
eff Fs
```

```voyd
// If implementation moves modules, keep the same ID.
@effect(id: "voyd.std.fs")
eff Fs
```
