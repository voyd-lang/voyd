# Value Types

This document specifies nominal value types declared with `val`.

## Grammar

```ebnf
ValueTypeDecl = Visibility?, "val", TypeHead, ObjectLiteral;
Visibility = "pub";
```

`TypeHead` and `ObjectLiteral` use the same surface forms as `obj` declarations.

## Well-Formedness

A `val` declaration is well-formed only if all of the following hold:

1. The declaration does not specify a base object.
2. Every field type is value-layout-compatible.
3. The inline value layout is not recursively defined.

A field type is value-layout-compatible if it is one of:

- a primitive scalar
- another `val` type
- a tuple or structural object whose members are value-layout-compatible
- a fixed array whose element type is value-layout-compatible
- a direct union whose top-level members are all value-layout-compatible values
- an optional whose payload is value-layout-compatible
- a type parameter
- a nominal object, trait, or function type used as an explicit reference-like field

If any field violates these rules, the program is ill-typed.

## Static Semantics

A `val` declaration introduces a nominal type with value semantics.

The type:

- has named fields
- may be generic
- may declare methods through `impl`
- may satisfy trait bounds for static dispatch
- does not implicitly convert to a trait object

Two `val` values have no observable identity relationship. Programs must not rely on aliasing, stable addresses, or identity-based equality for them.

## Copy Semantics

Unless a mutable borrow is explicitly requested with `~`, a `val` is copied when it is:

- assigned to a new binding
- passed to a plain parameter
- returned from a function

These copies are semantic requirements. The implementation may optimize their physical representation so long as observable behavior remains the same.

## Mutation

Mutation requires an addressable mutable location.

- `~self` borrows the receiver mutably.
- `~param` borrows an argument mutably.
- A mutable receiver call on a temporary `val` expression is invalid.

Mutating one `val` binding must not mutate any other binding unless both names refer to the same explicitly borrowed location.

## Containers And Embedding

`val` types may appear:

- as fields inside `obj` declarations
- as elements of arrays and fixed arrays
- as payloads of unions and optionals

Embedding a `val` in another aggregate does not give the embedded value independent identity.

If a direct union member is a `val` type, every direct member of that union must
also be a `val` type. This restriction applies to the top-level union members
only, so `Some<Vec2> | None` remains valid because the direct members are
`Some<Vec2>` and `None`, not `Vec2`.
