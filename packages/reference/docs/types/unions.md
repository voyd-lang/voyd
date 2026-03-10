---
order: 250
---

# Unions

Union types describe values that may be one of several nominal object variants.

```voyd
type Pet = Dog | Cat
```

Union members are nominal object types. Structural object aliases, tuples, and
intersections do not appear directly as union members.

## Generic unions

Generic nominal variants are supported.

```voyd
obj Some<T> {
  value: T
}

obj None {}

type Optional<T> = Some<T> | None
```

Matching works with full variant syntax or, when the variant head is unique in
the union, with omitted type arguments.

```voyd
match(value)
  Some { value }:
    value
  None:
    0
```

## Same-head variants

Voyd also supports unions whose members share the same nominal head, as long as
the instantiated payloads are disjoint.

```voyd
type PayloadA = { x: i32 }
type PayloadB = { y: i32 }

type MaybePair = Some<PayloadA> | Some<PayloadB>
```

When multiple variants share the same head, `match` arms must stay unambiguous.
