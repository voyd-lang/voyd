# Structural Object Array Illegal Cast

The following voyd program demonstrates a runtime `illegal cast` when using
structural object literals inside an array typed with a structural object type:

```voyd
use std::all

pub fn main() -> voyd
  let a: Array<{ key: String, val: i32 }> = [
    { key: "hi", val: 123 },
    { key: "there", val: 123 }
  ]
```

Running this program with the CLI results in:

```
RuntimeError: illegal cast
```

To inspect the heap type hierarchy of the generated WebAssembly, the helper
script `src/tools/print-type-hierarchy.ts` can be used. For example:

```
npx tsx src/tools/print-type-hierarchy.ts struct-array-bug.voyd ObjectLiteral
```

This prints the parent chain for all generated object literal types. The
structural array example produces output similar to:

```
ObjectLiteral-93371#120459 -> Object#16
ObjectLiteral-120465#120473 -> Object#16
```

Each object literal in the array receives a distinct type (`ObjectLiteral-…`).
The array expects elements of one of these types while the array literal
constructs elements of another, so the cast between sibling types fails even
though they share the common parent `Object#16`.

A nominal array declared as `Array<Bucket>` does not suffer from this issue
because the array element type and the constructed objects share the exact same
nominal type.

## Plan

1. When resolving array literals, propagate the expected element type to each
   element so that object literals reuse the anticipated structural type. ✅
2. Allow `resolveObjectLiteral` to adopt the expected type instead of always
   minting a new one, preventing sibling types from being generated. ✅
3. **New:** `getArrayElemType` only returned type arguments wrapped in
   `TypeAlias`, so structural object type arguments were discarded and the
   expected type never reached nested literals. Update it to return any
   structural type directly.
4. Confirm the fix by inspecting the heap type hierarchy and ensuring all
   literals in the array share the same parent chain.

## Result

Initial propagation changes were insufficient—E2E tests still reported
`RuntimeError: illegal cast`. Investigating the generated type hierarchy showed
that each object literal still minted its own structural type because
`getArrayElemType` returned `undefined` for structural arguments. Returning the
unwrapped element type ensures both literals initially share the same type id,
but `new_array` still clones this type during generic instantiation, so the
runtime cast failure persists.

```
RuntimeError: illegal cast
```

Next steps: trace how generic instantiation duplicates the structural element
type and adjust resolution or code generation so array literals and their
backing storage use the same heap type.

