# Compiler Next Checklist

Tracks which legacy compiler behaviors (`src/__tests__`) are already covered by the next-gen compiler tests in `src/next/codegen/__tests__`, and which still need implementation/coverage.

## Implemented in next-gen tests
- [x] Recursion and numeric codegen for simple programs (`fib.voyd`, `recursive_inference.voyd`).
- [x] Local/return type inference with tuples and `while` loops (`var_inference.voyd`).
- [x] Function overload resolution for scalar and labeled/structural parameters (`function_overloads.voyd`).
- [x] `elif` branching semantics (`elif.voyd`).
- [x] Structural object literals, spreads, and passing structs to functions expecting subsets (`structural_objects.voyd`).
- [x] Nominal object definitions and structural interoperability (passing nominal objects to structural params, field access; `nominal_objects.voyd`).

## Legacy coverage still missing in next-gen tests

### Functions, parameters, and scoping
- [ ] Optional parameter behavior (skipping optional args before labeled params, optional closures, Optional<T> not auto-optional, leftover-arg errors; `optional-params.e2e.test.ts`).
- [ ] `void` return handling that ignores body expressions (`void-type.e2e.test.ts`) and value-level `void`/`break` typing (`void-and-break.e2e.test.ts`).
- [ ] Block scoping errors for identifiers declared inside braces (`block-scope.e2e.test.ts`).
- [ ] Function vs method name conflicts resolved via labeled calls in pipelines (`method-fn-conflict.e2e.test.ts`).
- [x] Tail-call optimization detection (`compiler.test.ts` using `tcoText`).
- [ ] Labeled parameter expansion from objects and mixed internal/external labels beyond the overload sample (`labeled-params.e2e.test.ts`).
- [ ] Closures: capture semantics, higher-order params, recursive closures, pipe syntax, and parameter type inference (`closure.e2e.test.ts`).

### Control flow and typing
- [ ] Control-flow sugar: optional coalescing `??`, optional unwrap `:=`, optional chaining `?.`, `if is` type guards without else, `cond` expressions, and `for … in` sugar over arrays (`control-flow.e2e.test.ts`).
- [ ] Union/optional matching chains and clear error on union widening that exceeds parameter union (`inference.e2e.test.ts`, `generics-union-infer-negative.ts`).
- [ ] Recursive unions and branch handling (`recursive-union.e2e.test.ts`, `branch-node.e2e.test.ts`).
- [ ] Intersection types (e.g., `Animal + { legs: i32 }` in kitchen sink test18 within `fixtures/e2e-file.ts`).
- [ ] Structural generic inference with extra fields (`structural-inference.e2e.test.ts`).
- [ ] Comprehensive generic inference for arrays/maps/msg-pack, empty-array inference, and msg-pack map inference (tests 1–11 in `inference.e2e.test.ts`).
- [ ] Error reporting for unknown types and overload mismatches (`bad-type-arg-regression.e2e.test.ts`, `generic-signature-error.e2e.test.ts`, `type-checker.e2e.test.ts`).

### Data structures and stdlib
- [ ] Array helpers and iteration (`array-funcs.e2e.test.ts`: map/filter/reduce/find/some/every/each and iterable for_each).
- [ ] Array basics: object/tuple arrays, fixed arrays, structural acceptance, iterator structs, and push/pop returning optionals (kitchen sink tests 21–22, `arrays.e2e.test.ts`).
- [ ] Map iteration and initialization from pairs; string iterators (`maps-iterators.e2e.test.ts`).
- [ ] Map/MsgPack interactions: `Map<MsgPack>` overload resolution and tuple-array construction (`msg-pack-map-regression.e2e.test.ts`, `msg-pack-tuple-map.e2e.test.ts`).
- [ ] Linear memory API (grow/store/load/size) (`linear-memory.e2e.test.ts`).
- [ ] MsgPack encode/decode to linear memory, including array/map/string/i32 cases (`msg-pack.e2e.test.ts`).

### Objects, traits, and modules
- [ ] Nominal inheritance, method resolution across subclasses, and match-based type narrowing on nominal objects (kitchen sink tests 1–7 in `fixtures/e2e-file.ts`).
- [ ] Object/tuple destructuring, literal shorthand, and constructor/object argument expansion (`objects.e2e.test.ts`).
- [ ] Generic objects/impls and collection generics (e.g., `new_fixed_array`, `VecGeneric` impls, `VecBox`, module imports/aliases, structural reassignment, tuple member access, trait parameters/self returns in kitchen sink tests 8–31).
- [ ] Trait objects and dynamic dispatch with generic/nested trait parameters and iterator traits (`trait-object.e2e.test.ts` plus trait cases in kitchen sink).

### VSX/HTML parsing and rendering
- [ ] VSX runtime encoding to MsgPack: standard elements, self-closing components, `<ul>` maps, component children array literals (`vsx-combined.e2e.test.ts` and `fixtures/vsx.ts`).
- [ ] Component parsing: capitalized components, namespaced components (`UI::Card`/`ui::Card`), and built-in tags with internal capitals (`component-html-parser.test.ts`, parser section of `vsx-combined.e2e.test.ts`).
- [ ] Inline HTML expressions unwrapped (no extra list wrapper) and snapshot fidelity (`html-inline-expr-parser.test.ts` + snapshot).
- [ ] HTML/JSON union recursion and widening (`html-json.e2e.test.ts`).

```
obj Cat { lives: i32 }
obj Dog { noses: i32 }
obj Frog { feet: i32 }

type Pet = Cat | Dog | Frog

fn num(pet: Pet)
  pet.match
    Cat: pet.lives
    Dog: pet.noses
    Frog: pet.feet

pub fn main()
  let pet = Dog { noses: 1 }
  pet.num()
```
