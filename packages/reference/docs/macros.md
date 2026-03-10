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

## Exporting and importing macros

`pub macro` exports a macro from a module. Macros can also be re-exported with
`pub use`.

```voyd
pub use src::base_macros::all
```

## What this page does not cover

Voyd has internal parser and syntax-macro machinery, but that is not currently
documented as stable user-facing API. This reference only covers functional
macros that user code can define today.
