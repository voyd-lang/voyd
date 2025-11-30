# Lambda Implementation Plan (voyd)

## Legacy compiler audit (packages/compiler)
- Lambdas compiled via `compile-closure.ts` as structs with `__fn` plus captures; supertype/heap types are cached globally (`closureSuperType`, `fnTypeCache`, `envTypeMap`), which is unsafe across modules/hot reload because Binaryen type IDs are module-scoped.
- Call sites (`codegen/compile-call.ts`, `builtin-calls/compile-call-closure.ts`) rely on a `parameterFnType` side-channel and branch on `refTest` to reconcile mismatched funcref heap types. If a closure is used in multiple contexts, the last-applied expected type wins; mismatches can lead to traps or unchecked calls.
- Captures are emitted as immutable fields; semantics rejects assignment to captured vars (`semantics/check-types/check-closure.ts`) because codegen can’t handle mutated captures. Users must wrap state in objects.
- Closures lack RTT integration; other RTT helpers (field/method accessors) linear-scan hash tables and trap on miss without collision handling—avoid repeating that pattern for functions.
- Type normalization collapses object-ish returns to `voydBaseObject`, then re-casts, which hides precise return types and complicates generics/intersections.

## New compiler status (packages/compiler-next)
- HIR includes `HirLambdaExpr` with params/return/effect (`semantics/hir/nodes.ts`), but typing lacks a `lambda` case (`semantics/typing/expressions.ts`), and there is no binder/lowering or codegen path for lambdas.
- Call typing assumes only named functions; no capture analysis exists; codegen has no closure representation. RTT helpers exist for objects only.

## Implementation plan for lambdas in compiler-next
1) **Binding & Lowering**
   - Bind lambda parameters in a fresh scope; produce `HirLambdaExpr` with type/effect params and spans.
   - Record owning function/lambda to support capture discovery.
2) **Capture Analysis**
   - Walk lambda bodies to collect free variables; store ordered captures (with mutability info) on the HIR node. Decide capture ordering (e.g., lexical encounter) and ensure determinism.
3) **Typing**
   - Add `lambda` to `typeExpression`: build a function type from params/return/effect (effect is stubbed/ignored for now).
   - Use contextual expected type to infer missing param/return types and type arguments; instantiate lambda type params; type-check body with captured scope.
   - Cache resulting function type on the expression.
4) **Codegen Model**
   - Define a per-module closure base struct (e.g., `Closure { __fn, captures... }`) cached in the codegen context (not global).
   - Emit env struct types per lambda; inner function takes env + params. Store captures in env at construction.
   - If closures flow as objects, integrate with RTT base type; otherwise, use a dedicated closure heap type.
5) **Call Lowering**
   - Extend calls codegen to recognize closure values: load `__fn`, issue a single `call_ref` using the canonical heap type derived from the lambda’s typed signature. Avoid branching `refTest` fallbacks.
   - Preserve precise return types; only widen/cast when proven necessary for wasm typing, not by default.
6) **Mutability Strategy**
   - Decide policy: support mutated captures by storing them as mutable fields or require explicit object wrappers; reflect this in typing and codegen to avoid legacy rejection.
7) **Testing**
   - Add semantics + codegen fixtures: capture reads/writes, nested/recursive lambdas, generics/contextual typing, optional params, object/union returns, passing/returning lambdas, multiple call-site contexts.
   - Run `npm test` / targeted `npx vitest packages/compiler-next/...` before finishing.

Notes:
- Keep Binaryen type caches keyed by module + canonical function signature to avoid cross-module collisions.
- Avoid linear-scan RTT patterns with `unreachable` on miss; prefer deterministic tables or maps if RTT for closures is added.
- Effects not yet implemented: keep `effectType` parsed/preserved, but typing/codegen should ignore or stub it. Add TODO hooks where effect typing/inference and codegen would attach later, without enforcing constraints now.
