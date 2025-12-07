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
3. **Effect Lowering / Continuation Translation Layer (new, EIR)**: consumes Effect MIR, outputs explicit lowered constructs ready for codegen:
   - Splits effectful functions at effect sites into continuation lambdas (closures over locals + handler stack pointer).
   - Emits effect-operation sites as `$EffectRequest` + `Outcome.effect`.
   - Wraps function returns in `Outcome.value`.
   - Defines handler-dispatch scaffolding and the dynamic handler stack shape.
   - Widens effectful signatures to include `currentHandler` and `$Outcome` result so codegen just emits the provided shapes.
4. **Codegen (minimally touched)**: reuses existing mechanisms; only adjusted to:
   - use the `$Outcome` return type for effectful functions,
   - branch on `Outcome.tag` after effectful calls (effect branch goes to dispatcher, not `unreachable`),
   - call into generated handler dispatcher for `Outcome.effect`,
   - include runtime structs/helpers.

## Effect/Op IDs and Table Export (deterministic)
- IDs are assigned per module in declaration order during binding:
  - Effects: first appearance order at module scope.
  - Ops: first appearance order within their owning effect.
- IDs are stable across recompiles unless source ordering changes; new effects/ops append without renumbering existing ones.
- Imports re-use the callee module’s IDs by reading its exported table or JSON sidecar; exports always include the table for hosts and dependent modules.
- Serialization sidecar: `module.effects.json` `{ version:1, moduleId, effects:[{ id, name, label, ops:[{ id, name, label, resumeKind /*0 resume,1 tail*/ }] }], namesBlob /*utf8 base64*/, tableExport:"__voyd_effect_table" }`. Binding caches this per HIR hash and invalidates on source/order changes; codegen consumes it (never re-derives ids). Dependents load it during import resolution and emit diagnostics on missing ops/resumeKind mismatches.
- Emitted table (data export, e.g., `__voyd_effect_table`):
  - Header array: entries `{ effectId: i32, nameOffset: i32, opsOffset: i32, opCount: i32 }`.
  - Ops buffer: entries `{ opId: i32, resumeKind: i32 /*0 resume, 1 tail*/, nameOffset: i32 }`.
  - UTF-8 name blob; offsets index into this blob.
- Consumers:
  - Host harness maps ids -> names for debugging/dispatch.
  - Import resolution validates effect/op compatibility across modules.
  - Diagnostics use labels from the table.

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
  - For `tail` ops, allocate `$TailGuard` with `expected=1`; for `resume` ops, allocate a once-guard (`expected=1`) to enforce “resume zero or one time”.
- Pack continuation + tailGuard into `$EffectRequest`; wrap in `Outcome.effect`.

### Continuation IR (fed to codegen)
- Runs after MIR effect markup, performs ANF on effectful functions to make evaluation order explicit (short-circuit/match guards desugared).
- Records per-perform sites: `{siteId, envType, fields:[{name, typeId, wasmType, sourceKind:param|local|temp|handler, tempId?}], contFnName, postBlockLabel, siteOrder, handlerAtSite}` with deterministic ordering.
- Liveness collects locals/temps live after the perform and always includes the current handler. Dead temps are excluded; optional optimization nulls dead env fields before capture.
- `envType` is a GC struct with fields ordered as recorded; `contFnName` uses `__cont_<fnName>_<siteOrder>`; `siteOrder` is module-unique and monotonic for snapshot tests.
- `postBlockLabel` targets the remainder of the function; loops get explicit post labels; early returns handled with structured blocks.
## Continuation-Lowering Data Model
- For every effectful function, the translation pass records:
  - A list of perform sites with stable IDs.
  - A per-site environment struct layout (field order/type) containing live locals/temps, parameters as needed, and `currentHandler`.
  - A continuation funcref per site that reloads the env, restores `currentHandler`, and jumps to the post-perform block.
- Liveness rules:
  - Include all locals/temps whose values flow to code after the perform.
  - Always capture `currentHandler`.
  - Exclude values proven dead by flow analysis at the perform.
- Codegen uses the layout to emit `struct.new` envs, store captured fields, and pass envs to the continuation funcref. Funcrefs are one-shot; tail guards enforce single resume.

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

## Handler Stack Semantics
- Push `$HandlerFrame` on entering `try … handlers`; pop on exit regardless of control flow:
  - Normal completion: pop after clause/`finally`.
  - Early return/branch: emit epilogue to pop before exiting the function/scope.
  - Unhandled effect bubbling: pop current frame before re-raising the `Outcome.effect`.
  - Trap: `finally` lowering must pop; if a trap bypasses `finally`, frames become unreachable and GC collects.
- `finally` runs after clause result; if `finally` yields `Outcome.effect`, it propagates upward unchanged.
- Tail guard finalize:
  - After a clause returns `Outcome.value`, check `tailGuard.observed == expected`; trap otherwise.
  - If clause/`finally` yields `Outcome.effect`, the guard travels with the request unchanged.
- Resume enforcement:
  - `resume` uses the same guard shape with `expected=1`; each `resume` increments `observed` and traps on `observed > expected`.
  - Dispatcher must include guard state in top-level unhandled trap diagnostics.

## Call Lowering (minimal change)
- Pure callees: unchanged.
- Effectful callees:
  - Emit call -> `$Outcome`.
  - `if tag == value`: unbox payload -> continue.
  - `else`: call dispatcher with `Outcome`; the dispatcher returns `$Outcome` (no `unreachable`).
    - For direct callers expecting pure type: dispatcher must eventually yield `Outcome.value` or trap; lowerer unboxes the returned `Outcome.value`.
    - For effectful callers: propagate `Outcome.effect` upward unchanged.
- This logic is injected only where `meta.effectful === true`.

## Effect Operation Lowering (perform)
- Replace op calls with:
  1. Evaluate args -> boxed tuple.
  2. Build continuation (split rest of function).
  3. Guard: `tail` => `$TailGuard(1)`, `resume` => once-guard (`expected=1`, one-shot).
  4. Construct `$EffectRequest` with module-local `effectId/opId` constants.
  5. Return `Outcome.effect(request)`.

## Function Signatures and Funcrefs
- If a function’s effect row is non-empty => Wasm result is `$Outcome` **and** signature includes a hidden first parameter `currentHandler: ref null $HandlerFrame`.
- Funcrefs/closures/trait dispatch for effectful functions use the widened signature (handler param + `$Outcome` result type).
- Pure functions/closures stay as-is.
- Imports: if marked effectful, signature uses `$Outcome` + handler param; otherwise unchanged.
- Exports: only pure exports are host-callable by default. Effectful exports must surface an explicit effectful entry (see Host Boundary) or be wrapped in a pure function; otherwise emit a diagnostic.

## Tail and Resume Enforcement
- `tail`: runtime guard via `$TailGuard` + dispatcher finalize check; trap on observed != 1.
- `resume`: one-shot. Every `resume` op installs a guard with `expected=1`; double resume traps.

## Testing Strategy
- Add a small Wasm harness in tests to instantiate emitted modules, drive the dispatcher, and unwrap `Outcome`.
- Cover: single resume, double resume trap (one-shot), tail missing/extra, handler elimination to purity, higher-order callbacks carrying effects, unhandled effect trap, import/export smoke, effectful import/export wiring, nested handler stack teardown (including `finally`), top-level unhandled diagnostic labels, cross-module id reuse/mismatch diagnostics, host buffer overflow traps, externref continuation reuse, and CLI (`vt --run`) running effectful fixtures through the shared harness.

## Host Boundary (Exports, Continuations, Buffer Protocol)
- Default: only pure exports are host-callable. Effectful exports must either be wrapped in a pure API or expose an explicit effectful entrypoint; otherwise emit a diagnostic.
- Effectful entrypoint shape (snake_case in Voyd; no multi-return):
  - Define a struct `EffectResult { status: i32, cont: externref }`.
  - `pub fn main_effectful(buf_ptr: i32, buf_len: i32): EffectResult`
  - `pub fn resume_effectful(cont_ref: externref, buf_ptr: i32, buf_len: i32): EffectResult`
  - Helpers to read fields via primitives: `pub fn effect_status(res: EffectResult) -> i32` and `pub fn effect_cont(res: EffectResult) -> externref`.
  - `status` codes: `0` => value written to `buf_ptr` via MsgPack; `1` => effect request written to `buf_ptr`; negative => trap/diagnostic.
  - `cont` is an opaque Wasm GC ref (externref) holding the continuation; host stores it to keep it alive and passes it back unchanged.
- Runtime-owned helpers (not user-defined): `handle_outcome`, `read_value`, and `resume_continuation` are emitted/linked by codegen to implement the entry/resume pair and the buffer protocol.
- Buffer contract (linear memory, MsgPack suggested):
  - For `status=0`: write `{ kind: "value", value }`.
  - For `status=1`: write `{ kind: "effect", effectId, opId, resumeKind, args }` (args as an array/tuple payload).
  - Effect/op names are discoverable via the module’s effect/op table export; host uses it to map ids to labels.
  - Overflow handling: trap if a write would exceed `buf_len`; harness documents minimum recommended buffer size; hosts may retry with a larger buffer.
- JS host calls remain camelCase; only Voyd exports use snake_case.
- Continuations stay in Wasm GC; only the externref travels to JS to prevent premature collection.
- Shared tools: harness + `vt --run` share one effect table parser (from Wasm export or JSON sidecar) and one host loop; buffer min size documented (e.g., 4 KiB) and overflow tested. CLI defaults to the `compiler-next` path (legacy behind a flag) so developer workflows exercise the Wasm effects implementation by default.

### Host Boundary Sketch (Voyd + JS)
`handle_outcome`, `read_value`, and `resume_continuation` are compiler/runtime helpers (not user-defined); they are emitted or linked by codegen to implement the protocol.

Voyd:
```voyd
type EffectResult = { status: i32, cont: externref }

pub fn main_effectful(buf_ptr: i32, buf_len: i32): EffectResult
  handle_outcome(my_async(), buf_ptr, buf_len)

pub fn resume_effectful(cont_ref: externref, buf_ptr: i32, buf_len: i32): EffectResult
  let value = read_value(buf_ptr, buf_len)
  handle_outcome(resume_continuation(cont_ref, value), buf_ptr, buf_len)

pub fn effect_status(res: EffectResult) -> i32
  res.status

pub fn effect_cont(res: EffectResult) -> externref
  res.cont
```

JS:
```js
const { main_effectful, resume_effectful, effect_status, effect_cont } = instance.exports;
const bufPtr = 1024, bufLen = 4096;

let res = main_effectful(bufPtr, bufLen);
while (true) {
  const status = effect_status(res);
  if (status === 0) {
    const msg = decodeMsg(bufPtr, bufLen);
    console.log("done", msg.value);
    break;
  }
  if (status === 1) {
    const msg = decodeMsg(bufPtr, bufLen); // {kind:"effect", ...}
    if (msg.effectId === effectIds.HttpReq && msg.opId === opIds.get) {
      fetch(msg.url).then(async (resp) => {
        encodeMsg(bufPtr, bufLen, await resp.text());
        res = resume_effectful(effect_cont(res), bufPtr, bufLen);
        // loop continues
      });
      break;
    }
    throw new Error("Unhandled effect");
  }
  throw new Error("Unexpected status");
}
```

### `vt --run` Integration (concept)
- Build the Wasm module with effects enabled. Determine if the target export `main` (or specified function) is pure:
  - Pure and JS-transparent result (int/float/bool/string): call directly and log.
  - Effectful: require `main_effectful`/`resume_effectful`/`effect_status`/`effect_cont` and the effect/op table; run the host loop using the MsgPack buffer protocol to drive effects until completion, pretty-printing effect names from the table.
- Default entry is `main` from `src/pkg.voyd`; allow overriding the export name.

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
