# Effect Table Specification

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `src_next/effects`

## Overview

The effect table captures algebraic effect information for expressions and callable symbols. It operates alongside the type arena to provide a second dimension of analysis: while the type system reasons about values, the effect system tracks operations (I/O, state, async, etc.) that functions may perform. The table centralizes effect data so that inference, checking, and codegen can share consistent results.

## Terminology

- **EffectOp**: Individual effect operation such as `IO.read`, `State.put`, `Async.await`.
- **RegionId**: Optional identifier used to distinguish effect instances (e.g., separate state cells).
- **EffectRow**: Row-polymorphic set of operations plus an optional tail variable representing open rows.
- **EffectRowId**: Stable handle referencing an interned effect row in the table.
- **EffectRowVariable**: Symbol representing an open row in a polymorphic effect signature.
- **HIRExprId**: Identifier of an expression in the High-Level IR; used to map effect rows back to syntax.
- **UnificationContext**: Metadata describing why two effect rows are being compared.

## Design Goals

1. **Row polymorphism**: Support open effect rows that can be constrained and unified during inference.
2. **Interoperability**: Tie effect rows to function types in the `TypeArena`.
3. **Minimal duplication**: Intern effect rows to reuse identical sets and enable pointer equality checks.
4. **Diagnostics**: Preserve context so effect mismatches report clear error messages (missing handler, unhandled operation).
5. **Backend guidance**: Provide structured effect data for codegen (stack management, handler tables).

## Effect Model

Effects are represented as `EffectOp` entries. Each operation contains:

- `name`: Fully-qualified identifier (e.g., `Async.await`).
- `region`: Optional `RegionId` to distinguish multiple instances (e.g., `State<S1>`, `State<S2>`).

Effect rows are stored in normalized form: operations sorted lexicographically, duplicates eliminated, and tail variables tracked separately.

## API

```ts
type EffectRowId = number;
type HIRExprId = number;
type SymbolId = number;
type TypeSchemeId = number;
type NodeId = number;

interface EffectOp {
  /** Fully qualified effect operation name. */
  name: string;
  /** Distinguishes effect instances (optional). */
  region?: RegionId;
}

interface EffectRowVariable {
  /** Unique identifier for the row variable. */
  id: number;
  /** Rigid rows cannot be widened (used for concrete functions). */
  rigid: boolean;
}

interface EffectRowDesc {
  /** Canonicalized list of operations. */
  operations: readonly EffectOp[];
  /** Optional open tail variable for row polymorphism. */
  tailVar?: EffectRowVariable;
}

interface UnificationContext {
  location: NodeId;
  reason: string;
}

type UnificationResult =
  | { ok: true; substitution: EffectSubstitution }
  | { ok: false; conflict: EffectConflict };

type EffectSubstitution = {
  /** Solved tail variables. */
  rows: ReadonlyMap<number, EffectRowId>;
};

interface EffectConflict {
  left: EffectRowId;
  right: EffectRowId;
  /** Human-readable explanation (e.g., "missing Async.await"). */
  message: string;
}

interface EffectTable {
  /** Intern an effect row; canonicalizes operation order. */
  internRow(desc: EffectRowDesc): EffectRowId;

  /** Retrieve the descriptor for a previously interned row. */
  getRow(id: EffectRowId): Readonly<EffectRowDesc>;

  /** Compose two rows (union of operations, tail management). */
  compose(a: EffectRowId, b: EffectRowId): EffectRowId;

  /** Check if `sub` is permitted within `sup`, returning substitution or conflict. */
  constrain(
    sub: EffectRowId,
    sup: EffectRowId,
    ctx: UnificationContext
  ): UnificationResult;

  /** Record the effect row inferred for an expression. */
  setExprEffect(expr: HIRExprId, row: EffectRowId): void;

  /** Retrieve the effect row previously associated with an expression. */
  getExprEffect(expr: HIRExprId): EffectRowId | undefined;

  /** Record the latent effect of a function symbol (paired with TypeArena). */
  setFunctionEffect(symbol: SymbolId, scheme: TypeSchemeId, row: EffectRowId): void;

  /** Retrieve the latent effect for a function symbol. */
  getFunctionEffect(symbol: SymbolId): EffectRowId | undefined;
}

type RegionId = number;
```

### Commentary

- `compose` is used when sequencing expressions (`effect(expr1); effect(expr2)`), producing a combined row that includes all operations of both operands. Tail variables are merged; conflicts (e.g., incompatible rigid tails) surface via `constrain`.
- `constrain(sub, sup)` enforces effect subsumption: the `sub` row must not introduce operations absent from `sup`. When successful, it returns substitutions mapping open tails to more concrete rows; the caller can then update type/effect schemes accordingly.
- Expression effects are stored per HIR node, enabling later passes (e.g., effect handlers, optimizer) to query local context without re-running inference.
- Function effects tie into the symbol table via `SymbolId` and reference the type scheme representing the function signature. This allows tooling to display effect annotations directly beside type signatures.

## Interaction With Other Components

- **TypeArena**: Function descriptors include an `EffectRowId`. When instantiating a polymorphic function, the effect table provides substitutions for effect row variables.
- **SymbolTable**: Provides symbol identities for `setFunctionEffect` and stores effect metadata for diagnostics.
- **Macro Expander**: Not directly involved; effect information arises post-binding.
- **Codegen**: Uses effect rows to determine whether stack unwinding, handler registration, or coroutine support is required.

## Invariants

- Every interned row is normalized: operations sorted, duplicates removed.
- `compose` and `constrain` never mutate existing row entries; new rows are interned for results.
- `setExprEffect` is idempotent—the same expression should not receive conflicting rows. Divergent writes are treated as compiler bugs.

## Error Handling

- If `constrain` detects an operation in `sub` absent in `sup`, it returns a conflict. The type checker uses the provided message and context to report “unhandled effect” diagnostics.
- Attempting to assign an effect row to a symbol twice triggers an internal error; symbol effects are written exactly once after inference.

## Future Extensions

- **Effect handlers**: Extend the API to model handler scopes and to encode discharged operations.
- **Region scoping**: Associate regions with lexical scopes to support linear resources or borrow checking.
- **Serialization**: Persist effect rows alongside type arena data for incremental compilation and IDE tooling.
