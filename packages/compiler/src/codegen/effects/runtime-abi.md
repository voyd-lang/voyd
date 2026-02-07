# Effect Runtime ABI

- `$Outcome` (`voydOutcome`): struct `{ tag: i32, payload: eqref }`. `tag=0` wraps a boxed value tuple; `tag=1` wraps an effect request.
- `$EffectRequest` (`voydEffectRequest`): `{ effectId: i64, opId: i32, opIndex: i32, resumeKind: i32 /*0 resume, 1 tail*/, handle: i32, args: eqref /*boxed tuple*/, cont: ref null voydContinuation, tailGuard: ref null voydTailGuard }`.
- `$Continuation` (`voydContinuation`): `{ fn: funcref /*(env:anyref, resume:eqref) -> ref null $Outcome*/, env: anyref, site: i32 }`.
- `$TailGuard` (`voydTailGuard`): `{ expected: i32, observed: i32 }`. Tail handlers allocate with `expected=1`; runtime increments/validates.
- Helpers in `runtime-abi.ts` construct and read these structs; pure values and multi-value returns remain boxed per existing tuple boxing helpers and flow through `$Outcome.payload` when `tag=0`.
- Semantics reference: `docs/effects-backend.md` and `packages/reference/types/effects.md` (resume ≤1, tail =1, handler result vs continuation result).
