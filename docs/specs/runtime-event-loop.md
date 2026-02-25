# Voyd Runtime Event Loop Semantics

Status: Draft
Owner: Runtime + Host Integrations
Scope: host-side execution semantics for effectful exports (`main_effectful` / `resume_effectful`)

## Purpose

Define a host-independent runtime contract for async/effect execution so host
adapters (JS, Rust, etc.) behave the same under the same program and handler
logic.

This spec is normative for runtime behavior. Wire format details remain in
`docs/specs/host-protocol.md`.

## Non-goals

- Defining a built-in standard library of effects (for example `fs` or
  `fetch`).
- Defining host API ergonomics.
- Replacing host-specific event loop implementations.

## Normative Terms

- **Run**: One invocation of an effectful export and all resumptions produced by
  it.
- **Continuation step**: One transition from an `effect` result to the next
  `effect` or final `value` result.
- **Internal task**: Runtime-owned work inside a run (decode request, dispatch
  handler, encode resume payload, call `resume_effectful`).
- **External task**: Host-provided work that resolves a handler asynchronously
  (I/O completion, timer firing, user input, etc.).
- **Terminal state**: `completed`, `failed`, or `cancelled`.

## Terminal Outcome Contract

Conforming runtimes MUST expose a terminal outcome model equivalent to:

```ts
type RunOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "failed"; error: RuntimeError }
  | { kind: "cancelled"; reason?: unknown };
```

Where:

- exactly one terminal outcome is produced per run
- the first terminal transition wins
- `cancelled` is semantically distinct from `failed`

## Host-Agnostic Policy vs Host Mechanism

| Topic | Host-agnostic policy (normative) | Current JS-host mechanism (`packages/js-host`) |
| --- | --- | --- |
| Continuation ownership | A run has at most one active continuation step at a time. | `runEffectLoop` processes one `result` in a `while` loop. |
| Internal scheduling | Internal tasks are serialized per run. | Handler is awaited before the next `resume_effectful` call. |
| External scheduling | External task completion may resume a run only through the handler return path. | Handler may return a promise; `await handler(...)` resumes when it settles. |
| Yield model | Execution is cooperative, not preemptive. Scheduler MUST enforce bounded starvation with a fairness budget. | Suspension points are promise settlements from handlers. |
| Early completion | Host may terminate a run without resuming wasm by returning `end(...)`. | `handlerResult.kind === "end"` returns directly from `runEffectLoop`. |
| Missing capability | If no handler exists for a requested op, run fails deterministically. | Throws `Unhandled effect ...`. |
| Cancellation API | Conforming adapters MUST support explicit run cancellation. | No public cancellation API today (gap to close). |

## Task Classes

Adapters MUST model two task classes:

1. Internal continuation tasks:
   - start the run (`entry(...)`)
   - decode and validate effect/value payloads
   - invoke a matched handler
   - apply returned continuation call (`resume`, `tail`, or `end`)
2. External tasks:
   - events from capabilities used by handlers (timers, network, files, input,
     etc.)
   - host control actions (for example explicit cancellation, if supported)

Internal tasks MUST NOT run concurrently for the same run.

## Scheduler Phases and Queues

Conforming adapters MUST implement these logical queues/phases (naming may vary):

1. **Ready queue**: continuation steps that can execute immediately.
2. **External completion queue**: completed host async work ready to re-enter
   the scheduler.
3. **Timer queue**: monotonic-deadline timers.

Scheduler loop requirements:

1. Move due timers into external completion queue.
2. Move external completions into ready queue.
3. Execute ready steps up to a fairness budget.
4. Yield to host loop, then repeat while runs remain active.

## Ordering and Yield/Fairness Policy

### Ordering (MUST)

For a single run:

1. Effect requests are observed in wasm emission order.
2. A handler invocation for step `N+1` MUST NOT start before step `N` returns a
   continuation call and that call is applied (or the run becomes terminal).
3. For one effect request, exactly one returned continuation call is applied:
   `resume(...)`, `tail(...)`, or `end(...)`.
4. `tail` and `resume` kind checks MUST be enforced before resuming wasm.

### Yield/Fairness (MUST/SHOULD)

- Runtime execution is cooperative:
  - adapters MUST only switch away from a run at suspension points
  - adapters MUST preserve causal ordering when they resume
- Adapters SHOULD provide a yield strategy that prevents unbounded starvation of
  external tasks for long chains of immediately-resolved internal work.
- Adapters MUST enforce a finite fairness budget (`maxInternalStepsPerTick`) so
  no run can monopolize the scheduler indefinitely.
- Minimum conformance requirement:
  - if external tasks keep arriving, each active run and each external
    completion queue is serviced within finitely many scheduler ticks.
- Default recommendation:
  - `maxInternalStepsPerTick = 1024` (configurable).

Note: a pure synchronous handler chain with no suspension points can still
delay unrelated host work until the fairness budget boundary. This is expected
in this model.

## Cancellation and Finalization Semantics

Cancellation is required for runtime conformance.

State model:

- `running -> cancelled` is one-way and terminal.
- After cancellation, late external completions MUST be ignored for that run.
- After cancellation, adapters MUST release host-held continuation references
  and per-run resources (buffers, queues, bookkeeping).
- Cancel is idempotent: repeated cancellation requests are no-ops.
- Cancelling one run MUST NOT cancel unrelated runs unless explicitly requested.
- `cancelled` MUST map to `RunOutcome.kind === "cancelled"` (not `failed`).

Finalization rules:

- Host-side resource finalization MUST run on every terminal transition.
- Wasm `finally` blocks are only guaranteed for control paths that re-enter wasm
  normally via `resume_effectful`; they are not guaranteed after host-side
  cancellation without resume.

## Unhandled Async Error Semantics

Any of the following MUST transition the run to `failed`:

- handler throws or returns a rejected promise
- no handler exists for an effect op
- protocol mismatch (invalid status, op mismatch, invalid resume kind, decode or
  encode failure, buffer overflow)

Failure semantics:

- run result is an error/rejection
- continuation is closed (must not be resumed again by the adapter)
- no implicit retry or fallback dispatch is allowed
- adapter SHOULD surface failures to a configurable runtime-level error sink for
  observability (without changing run outcome)
- `failed` maps to `RunOutcome.kind === "failed"`.

## Timer and Time Semantics

This spec defines time semantics independent of language/runtime APIs:

- Time used for scheduling MUST be monotonic (not wall-clock time).
- Timer deadlines are compared in monotonic time units.
- Wall-clock adjustments (NTP, manual changes, DST) MUST NOT reorder existing
  timer deadlines.
- If multiple timers are due at the same monotonic instant, adapters SHOULD
  process them FIFO by registration order.

Current JS-host note: there is no built-in timer capability in `@voyd/js-host`;
timer behavior is provided by user handlers.

## Capability Availability and Failure Semantics

Capabilities are represented by registered handlers over effect ops.

- **Available**: a matching handler exists and runs.
- **Unavailable**: no matching handler exists; run fails deterministically.
- **Available but failing**: handler exists but returns an error; run fails with
  that error.

Adapters MUST NOT silently remap an unavailable capability to a different
handler.

## Conformance Scenarios

| Scenario | Input | Expected terminal/result behavior |
| --- | --- | --- |
| Resume step | handler returns `resume(v)` for a `resume` op | Runtime encodes `v`, calls `resume_effectful`, continues loop |
| Tail step | handler returns `tail(v)` for a `tail` op | Runtime encodes `v`, calls `resume_effectful`, continues loop |
| Resume kind violation | `resume` op handler returns `tail(...)` | Run fails before resumption |
| Tail kind violation | `tail` op handler returns `resume(...)` or `end(...)` | Run fails before resumption |
| Early host completion | handler returns `end(v)` | Run completes with `v`; no `resume_effectful` call for that step |
| Missing capability | no handler for requested op | Run fails deterministically (`Unhandled effect`) |
| Async handler rejection | handler promise rejects | Run fails with rejection reason |
| Protocol mismatch | invalid status or payload mismatch | Run fails with protocol error |
| Explicit cancellation | host requests cancel(runId) | Run transitions to `cancelled`; late completions are dropped |
| Fairness pressure | one run emits long immediate chain while others are ready | Scheduler yields at budget boundary; other ready work progresses |

## Adapter API Guidance

Conformance-facing APIs SHOULD expose `RunOutcome<T>` directly.

Adapters MAY additionally provide convenience APIs that:

- return `T` for `RunOutcome.kind === "value"`
- throw/reject for `failed` and/or `cancelled`

If convenience APIs collapse outcomes into throw/reject behavior, they MUST
still preserve the semantic distinction internally so conformance tests can
assert exact terminal state transitions.

## Executable Trace Example

```ts
// Pseudocode trace (host-agnostic behavior)
trace = []

step1 effect Async.await(1)
handler -> trace += "h1:start"; await external; trace += "h1:end"; return resume(2)
resume_effectful(2)

step2 effect Async.await(3)
handler -> trace += "h2:start"; return resume(4)
resume_effectful(4)

step3 value 40

// Required trace ordering:
// ["h1:start", "h1:end", "h2:start"]
```

This ordering is normative: step 2 cannot start before step 1's returned
continuation call is applied.

## Known Implementation Gap

`@voyd/js-host` now implements scheduler-driven ordering, cancellation outcomes,
fairness-budget controls, and deterministic conformance coverage with a virtual
clock + controlled queues. Remaining adapter-level gaps are capability
contracts that are not yet finalized in stdlib (notably fetch/input payload
schemas), tracked under `V-260`.
