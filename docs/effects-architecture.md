# Effects Architecture (Wasm GC, Minimal Codegen Surface)

This document explains how to implement the effects runtime semantics from `apps/reference/types/effects.md` using a small, isolated translation layer that sits **between semantics and codegen**. The goal is to keep core codegen changes minimal while enabling a future stack-switch backend. Think of this as a CPS/delimited-continuation lowering that emits the stable Outcome/EffectRequest ABI.

## Goals
- Preserve pure call paths: functions with empty effect rows keep the existing Wasm signatures and exports.
- Route only effectful code through a continuation backend that uses Wasm GC structs and closures.
- Minimize changes to existing codegen by confining new logic to:
  - effect-aware function metadata (return type becomes `$Outcome` for effectful),
  - effectful call lowering (branch on `Outcome.tag`),
  - effect-op lowering (emit `$EffectRequest`),
  - handler lowering/dispatcher,
  - tiny runtime helpers for `$Outcome`, `$EffectRequest`, `$Continuation`, `$TailGuard`.
- Keep the ABI compatible with a future stack-switch backend: only swap the continuation constructor/dispatcher later.

## Placement in the Pipeline
1. **Semantics/Typing** (existing): produces HIR + effect rows + tail metadata.
2. **Effect MIR** (already exists): records per-function effect rows, handler clauses, calls (pure vs effectful), tailResumptions.
3. **Continuation Translation Layer (new)**: consumes Effect MIR, outputs lowered representations ready for codegen:
   - Splits effectful functions at effect sites into continuation lambdas (closures over locals + handler stack pointer).
   - Emits effect-operation sites as `$EffectRequest` + `Outcome.effect`.
   - Wraps function returns in `Outcome.value`.
   - Defines handler-dispatch scaffolding and the dynamic handler stack shape.
4. **Codegen (minimally touched)**: reuses existing mechanisms; only adjusted to:
   - use the `$Outcome` return type for effectful functions,
   - branch on `Outcome.tag` after effectful calls,
   - call into generated handler dispatcher for `Outcome.effect`,
   - include runtime structs/helpers.

## ABI (stable)
- `$Outcome { tag: i32, payload: eqref }` with `tag=0` => boxed value tuple; `tag=1` => `$EffectRequest`.
- `$EffectRequest { effectId: i32, opId: i32, resumeKind: i32 /*0 resume, 1 tail*/, args: eqref, cont: ref null $Continuation, tailGuard: ref null $TailGuard }`.
- `$Continuation { fn: funcref /*(env, value) -> ref null $Outcome*/, env: anyref }`.
- `$TailGuard { expected: i32, observed: i32 }`.
- Runtime helpers (already in `runtime-abi.ts`) construct/read these; keep them as the single source.

## Dynamic Handler Stack
- Represent the stack as a GC struct chain (simpler than linear memory):
  - `$HandlerFrame { prev: ref null $HandlerFrame, effectId: i32, opId: i32, resumeKind: i32, clauseFn: funcref /*(env, request) -> ref null $Outcome*/, env: anyref, tailGuardPlan: i32 /*bool*/, label: i32 /*string table idx for diagnostics*/ }`.
  - The translation layer threads a `currentHandler: ref null $HandlerFrame` through effectful functions and stores it in the continuation env.
- Push a frame on entering `try … handlers`; pop when leaving (after `finally`).
- The dispatcher walks `currentHandler` on `Outcome.effect`, matching `effectId/opId` (and optional resumeKind).

## Continuation Construction (Delimited Style)
- At each effect site (perform), split the function:
  - Capture live locals + current handler frame into an env struct.
  - Emit a continuation funcref `(env, resumeValue) -> $Outcome` that restores locals, sets `currentHandler`, and executes the post-effect remainder.
  - For `tail` ops, allocate `$TailGuard` with `expected=1`; for `resume` ops, allocate an optional once-guard (resume ≤1) if desired.
- Pack continuation + tailGuard into `$EffectRequest`; wrap in `Outcome.effect`.

## Handler Lowering
- For each handler clause:
  - Build a clause funcref `(env, request) -> $Outcome`.
  - Unpack args, wrap `resume`/`tail` as a thin funcref that calls the request continuation (and updates guard).
  - Evaluate clause body; if `tail` guard exists, finalize after body returns (trap if observed != expected).
  - `finally`: run after clause result; if `finally` produces an `Outcome.effect`, it propagates upward.
- Dispatcher algorithm (effect branch in call lowering):
  1. Given `Outcome.effect(request)`, walk `currentHandler` frames.
  2. If match: invoke clause funcref with env + request; return its `$Outcome`.
  3. If no match: bubble the same `Outcome.effect` upward.
  4. Top-level unhandled: trap with effect/op label and observed tail guard (if present).

## Call Lowering (minimal change)
- Pure callees: unchanged.
- Effectful callees:
  - Emit call -> `$Outcome`.
  - `if tag == value`: unbox payload -> continue.
  - `else`: call dispatcher with `Outcome`; the dispatcher returns `$Outcome`.
    - For direct callers expecting pure type: dispatcher must eventually yield `Outcome.value` or trap; lowerer unboxes the returned `Outcome.value`.
    - For effectful callers: propagate `Outcome.effect` upward unchanged.
- This logic is injected only where `meta.effectful === true`.

## Effect Operation Lowering (perform)
- Replace op calls with:
  1. Evaluate args -> boxed tuple.
  2. Build continuation (split rest of function).
  3. Optional guard: `tail` => `$TailGuard(1)`, `resume` => once-guard if enforcing `≤1`.
  4. Construct `$EffectRequest` with module-local `effectId/opId` constants.
  5. Return `Outcome.effect(request)`.

## Function Signatures and Funcrefs
- If a function’s effect row is non-empty => Wasm result is `$Outcome`.
- Funcrefs/closures/trait dispatch for effectful functions use `$Outcome` result type.
- Pure functions/closures stay as-is.
- Imports: if marked effectful, signature uses `$Outcome`; otherwise unchanged.
- Exports: only pure exports are host-callable; effectful exports can be left un-exported or flagged (minimal gating).

## Tail and Resume Enforcement
- `tail`: runtime guard via `$TailGuard` + dispatcher finalize check; trap on observed != 1.
- `resume`: either allow multi-resume (current interpreter behavior) or add an optional once-guard (`expected=1`)—choose and document; tests must cover double resume if prohibited.

## Testing Strategy
- Add a small Wasm harness in tests to instantiate emitted modules, drive the dispatcher, and unwrap `Outcome`.
- Cover: single resume, double resume (if guarded), tail missing/extra, handler elimination to purity, higher-order callbacks carrying effects, unhandled effect trap, import/export smoke.
- Remove interpreter-based tests after parity is proven.

## Stack-Switch Compatibility
- Keep `Outcome`/`EffectRequest`/`Continuation` shapes intact.
- Isolate continuation construction and dispatcher in a backend module; later, swap the continuation builder to use `suspend/resume` primitives while keeping handler code and call lowering unchanged.

## Minimal Codegen Touchpoints (vs main)
- Function metadata: set result type to `$Outcome` for effectful functions.
- Call lowering: branch on `Outcome.tag` for effectful callees; invoke dispatcher on effect branch.
- Effect-op lowering: new path to emit `$EffectRequest` + `Outcome.effect`.
- Include runtime structs/helpers (already in `runtime-abi.ts`) in modules that need them.
- Optional: export gating diagnostic for effectful exports (can be stubbed if host-call not needed).

This architecture keeps the CPS/delimited continuation logic in a dedicated translation layer and limits codegen changes to a few well-defined hooks, while remaining future-proof for stack-switching.
