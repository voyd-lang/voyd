# Illegal Cast Root Cause

## Reproduction
- Run `vt --run sb/illegal-cast.voyd`.
- The program crashes with `RuntimeError: illegal cast`.

## What Happened
- Calling `r.get("a")` in `test.voyd` triggers the crash before any match arm code executes (reproduced with `debug_get.voyd`, which simply invokes `a().get("a")` and still traps).
- The generated WebAssembly for `Map.get` (`illegal-cast.wat:24734`-`illegal-cast.wat:24819`) checks whether the lookup result “extends” the `Some` constructor and then immediately downcasts it with `ref.cast (ref null $Some#144054#9)` / `ref.cast (ref null $Some#144054#7)`.
- Those struct IDs correspond to the instantiation the compiler expects for `Optional<Array<{ key: String, value: RecType }>>` and `Optional<{ key: String, value: RecType }>` respectively.
- At runtime the buckets actually hold `Some` wrappers that were specialized to the *narrower* value type inferred from the initializer (`String` in this program), so their struct type is `Some#…#15` (value field `String`) rather than the `Some#…#7`/`#9` variants the cast targets.
- The ancestor table still contains the generic `Some` type ID, so the `__extends` guard succeeds, but the subsequent `ref.cast` sees a different struct definition and traps with `RuntimeError: illegal cast`.

## Why It Happens
- The map implementation monomorphizes helper functions per `Map<T>` instantiation, but the value stored in each entry is recreated using the concrete initializer type.
- In this case `Map<RecType>` is initialized with `("a", "b")`. The tuple literal drives the entry object’s `value` field, and the optional wrappers that carry it end up specialized to `Some<String>`
- Later, `get#146895#1` assumes the optional still uses the `Some<RecType>` struct, so the `ref.cast` instruction targets `Some#144054#7`. Because the concrete wrapper is `Some#144054#15`, the cast fails even though both share the same nominal ancestor.
- The match in `main` is not involved—the illegal cast occurs during the `Map.get` call itself, before the outer `match` executes.
