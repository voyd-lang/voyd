# Std API Update Spec (Post-Migration Audit)

## 1. Locked Decisions

1. `Map` is renamed to `Dict` (hard cutover).
2. Mutability pairing is Swift-style naming, not `self/~self` overload identity:
   - mutating: `verb` (e.g. `sort`, `trim`, `merge`)
   - non-mutating: `verb+ed` (e.g. `sorted`, `trimmed`, `merged`)
3. Error model is hybrid:
   - pure/data-dependent failures: `Option` / `Result`
   - ambient/operational failures: effects
4. `Sequence` design is Option A (`iter() -> Iterator<T>`).
5. `Range` remains the current concrete i32 range type.
6. Current primitive mapping remains (`i32`, `i64`, `f32`, `f64`, bytes as `Array<i32>`).

## 2. Audit Snapshot (Current State)

This audit compares the implemented stdlib to the original API scope for `String`, `Array<T>`, and `Dict<K, V>` with the locked decisions above.

### 2.1 Implemented Areas (keep)

1. `Result` and `Option` core types and helper fns exist.
2. `Array` has broad functional and mutability-paired surface (`sort/sorted`, `reverse/reversed`, `push/pushed`, etc.).
3. `String` has core UTF-8 decode machinery and mutability pairs (`trim/trimmed`, `lower/lowered`, `upper/uppered`, `replace/replaced`).
4. `Dict` exists (currently value-generic but still `String`-keyed).
5. Baseline traits exist (`Eq`, `Ord`, `Hash`, `Default`, `Clone`, `Copy`, `Debug`, `Display`, conversion traits, `Sequence`, `Iterator`, `Collect`).

### 2.2 Critical Gaps

1. `String` rune/grapheme indexing/search/splitting surface is incomplete.
2. `Dict` is not yet `Dict<K, V>` and has no `DictKey` enforcement.
3. `DictEntry` power API is not implemented.
4. Several required `Array` overloads/return types are missing or shape-mismatched.
5. Test layout policy is inconsistent (`dict.voyd` still has inline tests).

## 3. Required API Work (Methods To Implement)

Only missing/partial items are listed below.

## 3.1 `String` Required Additions/Corrections

### 3.1.1 Construction and conversion

1. `fn init() -> String`
2. `fn with_capacity({bytes: i32}) -> String`
3. `fn from_utf8({bytes: Array<i32>}) -> Result<String, Utf8Error>`
4. `fn slice({range: Range<StringIndex>}) -> StringSlice`

### 3.1.2 Length/indexing model

1. `fn is_empty(self) -> bool`
2. `fn grapheme_len(self) -> i32`
3. `fn index(self, {after: StringIndex, by: i32 = 1}) -> Option<StringIndex>`
4. Keep rune-default stepping semantics and make `StringIndex` boundary-safe.

### 3.1.3 Grapheme API (explicit)

1. `fn graphemes(self) -> Sequence<StringSlice>`
2. `fn grapheme_index(self, {after: StringIndex, by: i32 = 1}) -> Option<StringIndex>`

### 3.1.4 Predicates and search

1. `fn starts_with(self, {prefix: StringSlice}) -> bool`
2. `fn ends_with(self, {suffix: StringSlice}) -> bool`
3. `fn contains(self, {substring: StringSlice}) -> bool`
4. `fn contains(self, {where: (i32) -> bool}) -> bool`
5. `fn find(self, {substring: StringSlice, from: StringIndex = start_index()}) -> Option<StringIndex>`
6. `fn rfind(self, {substring: StringSlice, to: StringIndex = end_index()}) -> Option<StringIndex>`
7. `fn find_range(self, {substring: StringSlice, from: StringIndex = start_index()}) -> Option<Range<StringIndex>>`

### 3.1.5 Split/lines/words

1. `fn split(self, {on: i32, max_splits?: i32, keep_empty: bool = false}) -> Array<StringSlice>`
2. `fn split(self, {on: StringSlice, max_splits?: i32, keep_empty: bool = false}) -> Array<StringSlice>`
3. `fn split(self, {where: (i32) -> bool, max_splits?: i32, keep_empty: bool = false}) -> Array<StringSlice>`
4. `fn lines(self, {keep_ends: bool = false}) -> Array<StringSlice>`
5. `fn words(self) -> Array<StringSlice>`

### 3.1.6 Transforms/parsing/representation

1. `trim/trimmed` must support `{chars: CharSet = whitespace}` (not only hardcoded ASCII trim bytes).
2. `replace/replaced` should align with label form `{old:, with:, max_replacements:}`.
3. `fn repeat(self, {count: i32}) -> String`
4. `fn pad_left(self, {width: i32, with: i32 = ' '}) -> String`
5. `fn pad_right(self, {width: i32, with: i32 = ' '}) -> String`
6. `parse_float` must be fully implemented (current implementation is a stub).
7. `fn to_debug(self) -> String`
8. `fn to_repr(self) -> String`

### 3.1.7 Type-shape corrections

1. `StringSlice` must be a real zero-copy view type (not alias to owned `String`).
2. `StringIndex` should be opaque or boundary-validated; not raw alias semantics.

## 3.2 `Array<T>` Required Additions/Corrections

### 3.2.1 Core/slicing

1. `fn get(self, {at: i32}) -> Option<T>` (label form)
2. `fn at(self, {at: i32}) -> T` (trapping)
3. `fn slice(self, {range: Range}) -> Array<T>`
4. Optional but recommended: `fn view(self, {range: Range}) -> ArrayView<T>`

### 3.2.2 Mutation

1. `fn truncate(~self, {len: i32}) -> void`

### 3.2.3 Functional/search overloads

1. `fn each(self, {do: (T) -> void}) -> void`
2. `fn contains(self, {where: (T) -> bool}) -> bool`
3. `fn find_index(self, {value: T}) -> Option<i32>`
4. `fn find_index(self, {where: (T) -> bool}) -> Option<i32>`

### 3.2.4 Ordering/signature alignment

1. `sort/sorted` comparator should use `Ordering` (or provide compatibility overloads).
2. Default comparator support for `Ord<T>` where possible.

### 3.2.5 Utilities

1. `fn group_by<K>(self, {key: (T) -> K}) -> Dict<K, Array<T>>`
2. `zip` should accept `Sequence<U>` (not only `Array<U>`).
3. `window` should return views if `ArrayView` is introduced.

## 3.3 `Dict<K, V>` Required Additions/Corrections

### 3.3.1 Generic keys and constraints

1. Replace `Dict<T>` with `Dict<K, V>`.
2. Introduce and enforce `DictKey` (or equivalent `Hash+Eq` aggregate constraint).
3. Implement `DictKey` for `String`.

### 3.3.2 API shape

1. `get`, `set`, `insert`, `remove`, `contains_key` should use labeled params (`{key: ...}`, `{value: ...}`).
2. Add `fn extend(~self, {entries: Sequence<(K, V)>}) -> void`.
3. Add conflict-aware `merge/merged` with `on_conflict` callback.
4. Add `fn map<U>(self, {map: (K, V) -> U}) -> Dict<K, U>`.
5. Keep/align `filter(self, {where: (K, V) -> bool}) -> Dict<K, V>`.

### 3.3.3 Entry API (required)

1. `fn entry(~self, {key: K}) -> DictEntry<K, V>`
2. On `DictEntry<K, V>`:
   - `or_insert({default: V})`
   - `or_insert_with({make: () -> V})`
   - `and_modify({f: (...) -> void})`
   - `remove()`

Note: shape can avoid reference returns if references are unavailable, but chaining semantics must exist.

## 3.4 Traits/Abstractions Required Corrections

1. `Copy` should be marker-style (no required method), or document intentional divergence.
2. `Formatter.write_str` should accept `StringSlice`.
3. Ensure trait method signatures use the locked label vocabulary consistently.
4. Add/expand unit tests for all trait definitions and at least one concrete impl each in std tests.

## 4. Testing Requirements (Mandatory)

1. Full unit test coverage for every public std API method in this spec.
2. Tests must live in dedicated module test files named `*.test.voyd`.
3. No inline tests inside production module files (`*.voyd`).
4. Minimum required structure:
   - `packages/std/src/string/type.test.voyd`
   - `packages/std/src/array.test.voyd`
   - `packages/std/src/dict.test.voyd` (move tests out of `dict.voyd`)
   - trait-specific tests under `packages/std/src/traits/*.test.voyd`
5. For each API: include happy path, edge cases, and failure path tests.
6. Unicode tests are required for rune and grapheme behavior.
7. Dict tests must include growth, collision handling, and key-constraint behavior.

## 5. Delivery Gates

1. All methods listed in Section 3 implemented.
2. Test layout conforms to Section 4.
3. `npm run test --workspace @voyd/std` passes.
4. `npm run test --workspace @voyd/compiler` passes.
5. `npm run typecheck --workspace @voyd/compiler` passes.
6. `npm run test --workspace @voyd/cli` passes.
7. `npm run typecheck --workspace @voyd/cli` passes.
