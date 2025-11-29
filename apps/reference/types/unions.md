# Unions

Union types represent a value that can be one of a predefined set of types.
Union members are **nominal objects only**. Structural aliases and intersections
cannot appear directly in a union.

A union type is defined by listing each of the types it may be, separated by the
pipe operator, `|`.

## Simple Unions

```voyd
type Animal = Cat | Dog

obj Cat {
  age: i32
  name: String
}

obj Dog {
  age: i32
  name: String
}
```

## Generic Nominal Unions (Same Head Allowed)

Union members can be generic nominal objects. Variants sharing the **same**
object head are allowed as long as each instantiation is disjoint (their
payloads cannot overlap).

```voyd
obj Result

obj Success<T>: Result {
  value: T
}

obj Failure<E>: Result {
  error: E
}

obj User {
  name: String
}

type FetchResult<T> = Success<T> | Failure<String>

fn fetch_user(id: String) -> FetchResult<User>
  if id == "root" then:
    Success { value: User { name: "Root" } }
  else:
    Failure { error: "User not found" }

fn render_user(id: String) -> String
  id.fetch_user()
    .match(result)
      Success<User>: "Loaded ${result.value.name}"
      Failure<String>: "Error: ${result.error}"
```

When matching against a generic union, include the type parameters when multiple
variants share the same name head, or omit them when the variant is unique (see
`match` in [Control Flow](../control-flow.md)).

Disjoint same-head examples:

```voyd
obj Some<T> {
  value: T
}

type PayloadA = { x: i32 }
type PayloadB = { y: i32 }

// Allowed: same head, disjoint payloads
type MaybePair = Some<PayloadA> | Some<PayloadB>
```

Overlapping payloads are rejected to keep narrowing sound:

```voyd
type Bad = Some<{ x: i32 }> | Some<{ x: String }> // Error: payloads overlap
```

## Soundness Rules

- Union members must be nominal objects. Structural aliases, intersections, and
  tuples cannot appear directly in a union type.
- Variants that share a nominal head are allowed only when their instantiated
  payloads are disjoint. Generic parameters of unionable heads are treated as
  invariant to prevent collapsing distinct instantiations.
- Runtime tags carry both the nominal head and an identifier for the concrete
  type arguments (including structural payloads). This keeps `Some<{ x: i32 }>`
  distinct from `Some<{ y: i32 }>` at runtime.
- `match` remains exhaustive: when multiple instantiations of the same head are
  present, each must be explicitly listed (or covered by a wildcard `else`).
