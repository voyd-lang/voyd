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

### Identifier contexts and hygiene

Macro expansion preserves where each identifier came from:

- Syntax written by the caller keeps call-site context.
- Literal identifiers in a macro template use the macro's definition context.
- `$` and `$$` splices keep the context carried by the spliced syntax.
- `identifier("debug_label")` creates a fresh context.
- `symbol_reference(symbol)` creates a reference tied to an existing symbol.

These rules apply through cloning, macro variables, lists, nested macros, and
imported macros. As a result, a binding introduced by a macro cannot capture a
matching caller name, and a caller name cannot capture a literal helper used by
the macro.

Use `identifier` when a macro needs to introduce a private binding:

```voyd
macro evaluate_once(value)
  let temporary = identifier("evaluate_once_value")
  `
    let $temporary = $value
    $temporary
```

Every call to `identifier` creates a distinct binding identity, even when the
debug labels match. Its operand may be a string or existing identifier syntax.
The identifier-syntax overload uses only that syntax's readable spelling as the
new identifier's debug label; it does not reuse the operand's binding identity.
This is useful when transforming names supplied as syntax, such as enum variant
names. Call `identifier` once, retain the returned syntax, and splice that same
value into the declaration and every reference. The label remains useful in
diagnostics and expansion views; it does not affect binding, exports, ABI,
serialized metadata, or Wasm names.
If a generated grouped `pub use` contains a fresh alias, the whole import stays
module-visible. Public effects and traits containing fresh operations or
requirements also stay module-visible because those members are otherwise
exposed through their owner.

Use `symbol_reference` when generated code must refer to a specific existing
value, type, or effect:

```voyd
fn private_normalize(value: i32) -> i32
  value + 1

pub macro normalized(value)
  let normalize = symbol_reference(private_normalize)
  `($normalize $value)
```

The operand must be an identifier or qualified symbol, never a string. The
result is valid only in reference positions and cannot name a declaration. An
unresolved operand is a compile error, and lookup never falls back to a caller
binding with the same spelling. Exported macros may reference private
definition-site helpers this way; the compiler records the helper as an
encapsulated dependency without exposing its name from the module.

Syntax inspection operations such as `calls` continue to compare readable
spelling. Voyd does not provide an intentional-capture or raw, unhygienic
identifier constructor.

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

Macro exports follow the same module and package boundaries as values and
types:

- an unmodified `macro` is module-private
- `pub macro` is visible inside its package
- code outside a nested source package can import the macro only when
  `pkg.voyd` re-exports it
- `module::all` includes exported macros at that one module level

For example:

```voyd
// src/schema/internal.voyd
pub macro declare_record(name)
  // ...

// src/schema/pkg.voyd
pub use self::internal::declare_record

// consumer: the physical `pkg` segment is omitted
use src::schema::declare_record
```

If a macro exists but lacks `pub`, the compiler identifies its declaration and
recommends adding `pub`. If a public macro lives behind a nested package
boundary, import it through the package root and add a root re-export when it is
part of the intended API. Declarations emitted by a macro obey their emitted
visibility; generation does not bypass a module or package boundary.

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

Compiler attributes (`@compiler_contract`, `@effect`, `@external`,
`@intrinsic`, `@intrinsic_type`, `@operation`, and `@type`) are reserved.
They cannot be declared as user attribute macros. When compiler and user
attributes are stacked, all user expansion runs first and compiler attributes
are then attached to the first emitted declaration. Put the preserved target
first when an attribute macro also emits companions.

`@operation(id: "...")` applies only to an effect operation and supplies its
stable host-facing identifier. `@type` is reserved for the language; it is not
currently a user-authored operation or attribute-macro feature.

Two imported macros with the same unaliased name are ambiguous. Use normal
import aliases to select explicit attribute names. Unknown attributes and using
a functional macro with `@` are compile-time errors rather than inert metadata.

Preserved syntax retains its source locations, including member and parameter
locations. This keeps documentation and diagnostics attached to the preserved
declaration. Generated syntax is attributed to the attribute invocation while
syntax spliced from the input retains its original provenance.

The same provenance rules apply to functional macros. Diagnostics point first
to caller syntax or the macro invocation. When generated template syntax is the
cause, tooling may also show its macro-definition location. Navigation and
rename follow binding identity, so a generated helper resolves to its actual
declaration rather than to an equal-looking caller name.

## What this page does not cover

Voyd has internal parser and syntax-macro machinery that is not a stable
user-facing API. Functional macros and declaration attribute macros are the
supported compile-time transformation surface.
