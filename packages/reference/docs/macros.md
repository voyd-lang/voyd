---
order: 100
---

# Macros

Voyd currently exposes user-defined functional macros through `macro` and
`pub macro`.

Macros run at compile time and expand into syntax.

## Declaring a macro

```voyd
pub macro inc(value)
  syntax_template (+ $value 1.0)
```

After importing the macro, calls expand before typing/code generation.

```voyd
use src::macros::all

inc(2.0)
```

## Templates and splicing

Macro bodies commonly build syntax with:

- `syntax_template ...`
- `$name` to splice a value into a template
- `$$value` to splice multiple entries

The standard library uses this model to implement surface features such as
`enum`, `for`, `??`, and `?.`.

When a macro replaces syntax while preserving its source-level role, use
`with_location(generated, source)` to transfer the source syntax location to
the generated form. This also preserves documentation provenance when, for
example, a function parameter becomes an object field.

## Exporting and importing macros

`pub macro` exports a macro from a module. Macros can also be re-exported with
`pub use`.

```voyd
pub use src::base_macros::all
```

## Declaration attribute macros

An attribute macro is a functional macro that receives a structured list of
attribute arguments and the syntax for the declaration immediately following
the attribute. It runs before binding and type checking.

```voyd
pub attribute macro companion(arguments, declaration)
  emit_many(
    declaration,
    \`(fn generated_companion() -> i32
      42)
  )
```

Import and apply an exported attribute macro with the ordinary macro import
rules. Import aliases also rename the attribute:

```voyd
use pkg::tools::companion as generate_companion

@generate_companion(description: "Generated helper")
fn original() -> i32
  1
```

The first macro parameter is a syntax list containing the arguments exactly as
written. Labeled arguments are `:` forms, so macros can inspect them with the
existing syntax helpers such as `length`, `get`, and `calls`. The second
parameter is declaration syntax. Returning that syntax preserves the
declaration; returning replacement syntax removes it; `emit_many` preserves or
replaces it with any number of declarations.

Attribute macros are supported on functions, module lets, type aliases,
objects, values, enums, traits, impls, effects, modules, and tests. Generated
declarations are expanded normally and may contain ordinary macro calls or more
attributes.

Consecutive user attributes run from top to bottom. Each macro receives the
syntax emitted by the previous macro, so a macro in a stack may receive an
`emit_many` declaration sequence. Expansion is limited to 64 nested attribute
expansions; exceeding the limit is a compile-time diagnostic at the attribute
invocation.

Compiler attributes (`@boundary`, `@compiler_contract`, `@effect`,
`@external`, `@intrinsic`, `@intrinsic_type`, and `@serializer`) are reserved.
They cannot be declared as user attribute macros. When compiler and user
attributes are stacked, all user expansion runs first and compiler attributes
are then attached to the first emitted declaration. Put the preserved target
first when an attribute macro also emits companions.

Two imported macros with the same unaliased name are ambiguous. Use normal
import aliases to select explicit attribute names. Unknown attributes and using
a functional macro with `@` are compile-time errors rather than inert metadata.

Preserved syntax retains its source locations, including member and parameter
locations. This keeps documentation and diagnostics attached to the preserved
declaration. Generated syntax is attributed to the attribute invocation while
syntax spliced from the input retains its original provenance.

## What this page does not cover

Voyd has internal parser and syntax-macro machinery that is not a stable
user-facing API. Functional macros and declaration attribute macros are the
supported compile-time transformation surface.
