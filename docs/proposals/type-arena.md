# Type Arena Specification

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `src_next/types`

## Overview

The type arena is an intern pool and constraint engine for all type information derived during semantic analysis. It canonicalizes structurally identical types, provides handles (`TypeId`) that remain stable across passes, and exposes utilities for type scheme instantiation and unification. This replaces the current practice of mutating syntax nodes to store type data.

## Terminology

- **TypeId**: Opaque handle into the arena representing a unique, canonicalized type.
- **TypeDescriptor**: Structural description of a type variant stored in the arena (nominal, structural, function, etc.).
- **TypeParamId**: Handle representing a universally-quantified type parameter within a scheme.
- **TypeScheme**: Pair of type parameters and a body TypeId representing polymorphic definitions.
- **ConstraintSet**: Collection of trait bounds or structural predicates associated with a type parameter.
- **Substitution**: Map from `TypeParamId` to `TypeId` describing a unification result.
- **UnificationContext**: Metadata passed to constraint solving for error reporting (source location, reason).
- **Interning**: Allocating a canonical representation of a value inside a pool so that structurally equivalent entries share the same identity. Looking up or creating a type in the arena always returns the unique `TypeId` for that shape, enabling pointer equality comparisons.

## Design Goals

1. **Canonicalization**: Equivalent types share the same `TypeId`, enabling pointer-based comparisons.
2. **Persistence**: Once allocated, descriptors do not change; backreferences (like type schemes) always see consistent data.
3. **Extensibility**: New type variants (e.g., effectful functions, capability types) can be added without restructuring client code.
4. **Separation**: Keep type inference logic (`TypeArena`) separate from syntax to avoid accidental AST mutation.
5. **Performance**: Arena operations are O(1) amortized; unification uses union-find style path compression where applicable.

## Type Variants

| Variant          | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| Primitive        | Built-in scalar types (`i32`, `String`, `voyd`, etc.)              |
| Recursive        | Recursive binder (`μT. ...`) for recursive type aliases            |
| Trait            | Traits declared with `trait`; referenced by `SymbolId`             |
| NominalObject    | Objects declared with `obj`; referenced by `SymbolId`              |
| StructuralObject | Reference types defined via structural object literals (`{ ... }`) |
| Function         | Signature with parameter list, return type, and effect row         |
| Union            | Set of alternative `TypeId`s (canonicalized order)                 |
| Intersection     | Combination of nominal + structural requirements                   |
| FixedArray       | WASM GC array wrapper with element type                            |
| TypeParameterRef | Placeholder referring to a `TypeParamId` within a scheme           |

Separating traits from nominal objects mirrors the language surface: traits carry behavioral contracts, while nominal objects describe concrete data layouts. Distinguishing their `kind` values keeps downstream passes (effects, impl resolution, code generation) from relying on ad-hoc metadata checks.

### Recursive types

Recursive types are represented as a first-class arena node:

```ts
type RecursiveTypeDesc = {
  kind: "recursive";
  binder: TypeParamId;
  body: TypeId;
};
```

- `binder` acts like a local `μ`-binder (alpha-renamable); `body` may reference itself via `type-param-ref(binder)`.
- Substitution must treat `recursive` as a binder: substitutions that mention `binder` are not applied under the binder.

## API

```ts
type TypeId = number;
type TypeSchemeId = number;
type TypeParamId = number;
type SymbolId = number;
type EffectRowId = number;

interface TraitTypeDesc {
  /** Name for debugging; not used for equality. */
  name: string;
  /** Symbol defining the trait. */
  owner: SymbolId;
  /** Applied type arguments (empty when none). */
  typeArgs: readonly TypeId[];
}

interface NominalObjectDesc {
  /** Name for debugging; not used for equality. */
  name: string;
  /** Symbol defining the nominal type. */
  owner: SymbolId;
  /** Applied type arguments (empty when none). */
  typeArgs: readonly TypeId[];
}

interface StructuralObjectDesc {
  /**
   * Canonicalized list of reference-type fields sorted lexicographically.
   * Structural objects support width subtyping: additional fields on the
   * value do not break compatibility.
   */
  fields: readonly { name: string; type: TypeId }[];
}

interface FunctionTypeDesc {
  /** Parameter types in declaration order. */
  parameters: readonly { type: TypeId; optional: boolean }[];
  /** Return type. */
  returnType: TypeId;
  /** Effect row describing side effects; `EffectTable` owns the row. */
  effects: EffectRowId;
}

interface IntersectionTypeDesc {
  /** Nominal constraint (nominal object or trait TypeId) or undefined. */
  nominal?: TypeId;
  /** Structural component enforced alongside nominal. */
  structural?: TypeId;
}

interface ConstraintSet {
  /** Required trait implementations. */
  traits?: readonly TypeId[];
  /** Structural predicates (e.g., must contain field). */
  structural?: readonly StructuralPredicate[];
}

interface StructuralPredicate {
  field: string;
  type: TypeId;
}

interface TypeDescriptor {
  kind:
    | "primitive"
    | "recursive"
    | "trait"
    | "nominal-object"
    | "structural-object"
    | "function"
    | "union"
    | "intersection"
    | "fixed-array"
    | "type-param-ref";
  data: unknown; // variant-specific payload stored internally
}

interface UnificationContext {
  /** AST node requesting the unification (for diagnostics). */
  location: NodeId;
  /** Human-readable reason (e.g., "call argument vs parameter"). */
  reason: string;
}

type UnificationResult =
  | { ok: true; substitution: Substitution }
  | { ok: false; conflict: UnificationConflict };

type Substitution = ReadonlyMap<TypeParamId, TypeId>;

interface UnificationConflict {
  left: TypeId;
  right: TypeId;
  message: string;
}

interface TypeArena {
  /** Retrieve the descriptor for a previously interned type. */
  get(id: TypeId): Readonly<TypeDescriptor>;

  /** Primitive types are interned once and reused. */
  internPrimitive(name: string): TypeId;

  /** Intern a trait type. */
  internTrait(desc: TraitTypeDesc): TypeId;

  /** Intern a nominal object (Option<T>, MsgPack, etc.). */
  internNominalObject(desc: NominalObjectDesc): TypeId;

  /** Intern a structural object type (reference semantics, width subtyping). */
  internStructuralObject(desc: StructuralObjectDesc): TypeId;

  /** Intern a function signature, including effect row. */
  internFunction(desc: FunctionTypeDesc): TypeId;

  /** Intern union variants; members are canonicalized internally. */
  internUnion(members: readonly TypeId[]): TypeId;

  /** Intern intersection of nominal/structural parts. */
  internIntersection(desc: IntersectionTypeDesc): TypeId;

  /** Intern fixed-array type (used for WASM GC arrays). */
  internFixedArray(element: TypeId): TypeId;

  /** Bridge to effect system for type parameters referencing effectful functions. */
  internTypeParamRef(param: TypeParamId): TypeId;

  /** Create a polymorphic type scheme (quantified type). */
  newScheme(
    params: readonly TypeParamId[],
    body: TypeId,
    constraints?: ConstraintSet
  ): TypeSchemeId;

  /** Instantiate a scheme with explicit type arguments. */
  instantiate(
    scheme: TypeSchemeId,
    args: readonly TypeId[],
    ctx?: UnificationContext
  ): TypeId;

  /** Attempt to unify two types, returning substitution or conflict. */
  unify(a: TypeId, b: TypeId, ctx: UnificationContext): UnificationResult;

  /** Apply a substitution to a type (used after unification). */
  substitute(type: TypeId, subst: Substitution): TypeId;

  /** Add constraint information, widening type parameter bounds. */
  widen(type: TypeId, constraint: ConstraintSet): TypeId;
}
```

### Commentary

- **Interning rules**: For unions and intersections, the arena canonicalizes member order and collapses nested unions to avoid combinatorial explosion.
- **Nominal equality**: Trait and nominal-object types are interned by their defining symbol; equality requires matching `owner` ids and pairwise-equal applied type arguments.
- **Structural objects**: Field order is normalized during interning, but compatibility relies on width subtyping—values with additional fields remain assignable. Pointer equality indicates identical shape, while the checker uses the stored field map for subset checks.
- **Future value types**: Value-level structs (`%{}`) are not yet modeled; when added, they will require a separate descriptor to capture copy semantics and layout.
- **Type parameters**: Represented explicitly via `TypeParamId` and only appear within schemes or instantiated copies; they allow higher-rank inference when combined with `EffectTable`.

### Working with `type-param-ref`

A `type-param-ref` descriptor links back to a quantified type parameter inside a
`TypeScheme`. The arena uses it to keep polymorphic definitions compact until a
caller supplies concrete type arguments.

```text
fn identity<T>(value: T) -> T
```

1. The binder creates a scheme `∀T. (T) -> T` and allocates a `TypeParamId`
   for `T`.
2. Both occurrences of `T` in the function type are stored as
   `type-param-ref` entries pointing at that `TypeParamId`.
3. When a call site invokes `identity<i32>(5)`, the type checker clones the
   scheme using `TypeArena.instantiate`, which replaces the two
   `type-param-ref` placeholders with the concrete `TypeId` for `i32`.
4. If inference needs to solve for an unknown type, those placeholders remain
   until unification binds them, allowing the checker to accumulate constraints
   before deciding on a concrete `TypeId`.

Because the placeholders live entirely inside the arena, downstream passes
never consult the original syntax to recover the relationship between the
parameter and its uses.

## Interaction With Other Components

- **Symbol Table**: Trait and nominal-object descriptors reference their defining symbols, enabling quick lookups for trait implementations and associated metadata.
- **Effect Table**: Function descriptors store an `EffectRowId` to link type-level behavior with effect analysis.
- **Type Checker**: Maintains working substitutions (union-find) while calling `unify` and `instantiate`.
- **Codegen**: Uses arena data to compute memory layouts and GC metadata.

## Type Aliases and Implementations

- **Type aliases**: Aliases (`type Name = ...`) do not allocate fresh `TypeId`s. During binding, the alias symbol records the resolved `TypeId` (or `TypeSchemeId` for generics) created by the arena. This preserves the alias for formatting while keeping the arena canonical.
- **Implementations (`impl`)**: Trait implementations are relationships between trait `TypeId`s and concrete type `TypeId`s. They are tracked outside the arena (e.g., in the symbol table or trait registry) because they enrich behavior rather than introducing new types. The arena simply provides the canonical ids that the impl registry references. Generic implementations store a `TypeSchemeId` that describes their type parameters; when matching an `impl` to a call site, the trait registry invokes `TypeArena.instantiate`/`TypeArena.unify` to map the scheme onto the concrete type arguments supplied by generic objects or callers.

## Invariants

- Every `TypeId` returned by the arena is unique to its descriptor; pointer equality implies structural equality.
- `instantiate` enforces arity checks; passing mismatched argument counts results in an error via `UnificationContext`.
- `unify` never mutates existing descriptors. Conflicts provide descriptive messages for diagnostics.

## Error Handling

- When interning invalid descriptors (e.g., structural type with duplicate fields), the arena should throw an internal error—callers must sanitize inputs.
- `widen` applied to non-parameter types is a no-op and surfaces a diagnostic so callers can adjust logic.

## Future Extensions

- **Associated types**: Extend `ConstraintSet` to support equality constraints.
- **Effect polymorphism**: Type schemes could quantify over effect row variables, complementing the effect table design.
- **Caching**: Persist arena segments between incremental builds to avoid re-interning unchanged libraries.
- **Value structs**: Introduce a dedicated descriptor for `%{}` struct definitions once the language surface is finalized.
