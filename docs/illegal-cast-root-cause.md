# Illegal Cast Root Cause

## Reproduction
- Run `vt --run test.voyd`.
- The program crashes with `RuntimeError: illegal cast`.

## What Happened
- Calling `r.get("a")` in `test.voyd` triggers the crash before any match arm code executes (reproduced with `debug_get.voyd`, which simply invokes `a().get("a")` and still traps).
- The generated WebAssembly for `Map.get` (`illegal-cast.wat:24734`-`illegal-cast.wat:24819`) checks whether the lookup result “extends” the `Some` constructor and then immediately downcasts it with `ref.cast (ref null $Some#144054#9)` / `ref.cast (ref null $Some#144054#7)`.
- Those struct IDs correspond to the instantiation the compiler expects for `Optional<Array<{ key: String, value: RecType }>>` and `Optional<{ key: String, value: RecType }>` respectively.
- At runtime the buckets actually hold `Some` wrappers that were specialized to the *narrower* value type inferred from the initializer (`String` in this program), so their struct type is `Some#…#15` (value field `String`) rather than the `Some#…#7`/`#9` variants the cast targets.
- The ancestor table still contains the generic `Some` type ID, so the `__extends` guard succeeds, but the subsequent `ref.cast` sees a different struct definition and traps with `RuntimeError: illegal cast`.

## Why It Happens
- The map implementation monomorphizes helper functions per `Map<T>` instantiation, but the value stored in each entry is recreated using the concrete initializer type.
- In this case `Map<RecType>` is initialized with `("a", "b")`. The tuple literal drives the entry object’s `value` field, and the optional wrappers that carry it end up specialized to `Some<String>` (see `illegal-cast.wat:18612`-`illegal-cast.wat:18646` for the construction and `illegal-cast.wat:24702`-`illegal-cast.wat:24724` for the `Some<String>` accessor table).
- Later, `get#146895#1` assumes the optional still uses the `Some<RecType>` struct (`illegal-cast.wat:24758`-`illegal-cast.wat:24788`), so the `ref.cast` instruction targets `Some#144054#7`. Because the concrete wrapper is `Some#144054#15`, the cast fails even though both share the same nominal ancestor.
- The match in `main` is not involved—the illegal cast occurs during the `Map.get` call itself, before the outer `match` executes.

## Suggested Direction
- Align the specialization that `Map.get` expects with the actual wrappers produced during initialization/mutation. One approach is to ensure the map always stores `Some<T>` using the same struct ID it will later downcast to, even when the current payload is a subtype of `T`.
- Alternatively, loosen the runtime check: instead of hard-casting to a single `Some<T>` struct, inspect the wrapper returned from the bucket and accept any `Some` whose payload is compatible with the declared `T`. That would avoid traps at the expense of a slightly more permissive runtime check.
