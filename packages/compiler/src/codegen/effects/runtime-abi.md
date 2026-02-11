# Effect Runtime ABI

- `$Outcome` (`voydOutcome`): struct `{ tag: i32, payload: eqref }`. `tag=0` wraps a boxed value tuple; `tag=1` wraps an effect request.
- `$EffectRequest` (`voydEffectRequest`): `{ effectId: i64, opId: i32, opIndex: i32, resumeKind: i32 /*0 resume, 1 tail*/, handle: i32, args: eqref /*boxed tuple*/, cont: ref null voydContinuation, tailGuard: ref null voydTailGuard }`.
- `$Continuation` (`voydContinuation`): `{ fn: funcref /*(env:anyref, resume:eqref) -> ref null $Outcome*/, env: anyref, site: i32 }`.
- `$TailGuard` (`voydTailGuard`): `{ expected: i32, observed: i32 }`. Tail handlers allocate with `expected=1`; runtime increments/validates.
- `init_effects(handle_table_ptr: i32)` is compiler-emitted. Hosts write a
  `u32` handle table to linear memory and pass its base pointer to initialize
  runtime handle lookup.
- Helpers in `runtime-abi.ts` construct and read these structs; pure values and multi-value returns remain boxed per existing tuple boxing helpers and flow through `$Outcome.payload` when `tag=0`.
- Semantics reference: `docs/effects-architecture.md` and `packages/reference/types/effects.md` (resume <= 1, strict tail exactly-once before clause exit/effect propagation).
- Backend status: only `gc-trampoline` is implemented. If stack-switch is requested, backend selection fails closed to `gc-trampoline`.
