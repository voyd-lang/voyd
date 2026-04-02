# Event-Loop Runs and Tasks

Status: Proposed
Owner: Runtime + Std + Language
Scope: in-language concurrency model, task ownership, cancellation, failure semantics, and timer APIs

## Summary

Voyd should adopt a single-threaded, event-loop-driven concurrency model that
feels familiar to Node/JS while staying explicit about ownership and failure.
The host still starts a root **run**. Voyd code gains first-class **tasks**
inside that run.

Core direction:

- keep execution cooperative and event-loop driven
- make `Task<T>` the primary in-language concurrency abstraction
- keep **structured concurrency** as the default
- allow **detached** work explicitly for timer/background use cases
- define timers as library APIs built on the same task model rather than as a
  separate concurrency mechanism

This proposal builds directly on `docs/specs/runtime-event-loop.md`, the
existing high-level SDK `sdk.run(...)` execution path, and the lower-level JS
host managed-run scheduler.

## Why This Exists

`std::time::sleep` already relies on host event-loop behavior, and the JS host
already exposes managed runs plus cancellation. What Voyd does not yet have is
an in-language model for:

- starting concurrent work
- owning that work
- cancelling it
- observing completion and failure
- defining what detached/background work means

That gap is why `V-337` removed misleading `on_timeout` and `on_interval`
helpers from the launch surface. Those APIs need a task model underneath them.

## Goals

- Define a first-class concurrency model for Voyd code.
- Keep the model event-loop driven and host-independent.
- Align the language surface with the existing runtime event loop spec.
- Make ownership, cancellation, and failure semantics explicit.
- Provide a clear foundation for `std::time`, `std::fetch`, and future
  background I/O APIs.
- Preserve room for later worker/thread models without coupling this design to
  them.

## Non-Goals

- OS-thread parallelism.
- Shared-memory data races or atomics.
- Exact source-level compatibility with JS `Promise` APIs.
- Preemptive scheduling.
- Final syntax for every closure/callback form.

## Terminology Direction

This proposal intentionally separates **task** from **worker**.

- **Task** means concurrent work scheduled inside a run's event loop.
- **Worker** should be reserved for future thread-backed execution on a
  different thread.

That distinction should stay stable across the language and std surface.

Examples of the intended meaning:

- `task::spawn(...)`: same run, same event loop, concurrent but not parallel
- `worker::spawn(...)`: future API, different thread, actually parallel

Using separate terms now avoids a common trap where a lightweight async task
API later becomes overloaded with thread semantics.

## Existing Constraints

Today the runtime already has the right host-side shape:

- `docs/specs/runtime-event-loop.md` defines ready, external-completion, and
  timer queues plus cancellation and fairness.
- `packages/sdk` already exposes `sdk.run(...)` as the simple high-level
  execution API.
- `packages/js-host` exposes `VoydRunHandle<T>` with `outcome` and `cancel` for
  lower-level managed-run control.
- `std::time` currently provides `Duration`, `Instant`, `SystemTime`, and
  `sleep`.

The main missing piece is an in-language scheduler model for more than one
concurrent continuation chain inside the same run.

## Proposal

### 1. Core Abstractions

#### Run

A **run** remains the host/runtime concept.

- A host/runtime layer creates a run when executing an entrypoint.
- At the high-level SDK surface this is already done via `sdk.run(...)`.
- At the lower-level JS host surface this exists as managed-run execution with
  a `VoydRunHandle<T>`.
- A run owns the event loop instance, task registry, timer registrations, and
  host capability bookkeeping for that invocation.
- A run is the root cancellation boundary.

This preserves the current SDK API shape, keeps `sdk.run(...)` as the simple
default execution entrypoint, and keeps `RunHandle` as a lower-level host-facing
concept rather than the primary language surface.

#### Task

A **task** is the in-language unit of concurrent work.

- A task belongs to exactly one run.
- A task has a terminal outcome: `value`, `failed`, or `cancelled`.
- A task executes cooperatively on the run's event loop.
- Two tasks in the same run never execute simultaneously.

`Task<T>` is the user-facing handle for spawned work.

#### Structured Owner

Every task has an owner:

- another task
- a task group
- or the run itself

Ownership determines lifetime, cancellation propagation, and how failures are
surfaced.

#### Detached Task

A **detached task** is not owned by the creating task. It is re-parented to the
run.

- it may outlive the creating task
- it still runs on the same event loop
- it still participates in run shutdown and root cancellation

This is the escape hatch needed for background work and timer callbacks.

### 2. Execution Model

Voyd concurrency should be event-loop driven, cooperative, and single-threaded
within a run.

A task runs until one of the following happens:

- it returns a value
- it fails
- it is cancelled
- it reaches a suspension point

Initial suspension points:

- an effect operation whose handler completes asynchronously
- `task::join(...)`
- `task::yield_now()`
- `time::sleep(...)`
- future queue/channel wait operations

This should feel similar to Node/JS async work:

- no preemption in the middle of normal execution
- progress happens when work yields back to the event loop
- timers and I/O re-enter through the scheduler

### 3. Queue and Turn Semantics

The current runtime spec already defines three logical queues:

- ready queue
- external completion queue
- timer queue

This proposal maps them to the language task model as follows:

- the **ready queue** is the run's task-ready queue
- the **external completion queue** carries completed I/O, timers, and host
  resumptions back into the run
- the **timer queue** remains monotonic-time based

Per scheduler tick:

1. Move due timers into the external completion queue.
2. Move external completions into the ready queue.
3. Drain ready work up to the fairness budget.
4. Yield to the host loop.

This is intentionally close to Node/JS:

- ready work behaves like a microtask-ish queue
- timers and host completions behave like macrotask/event sources
- fairness prevents a run from monopolizing the host forever

### 4. Spawn Semantics

Proposed library surface:

```voyd
use std::task

let child = task::spawn(() =>
  fetch_user(id: 42)
)
```

`spawn(...)` rules:

- creates a new child task in the current run
- attaches the child to the current structured owner
- schedules the child asynchronously
- does not synchronously execute the child body inside the caller's stack

The child should become eligible to run in the same scheduler turn after the
current step yields, before the event loop waits for unrelated external work.

That gives Voyd a familiar "start soon, not inline" model without pretending
the work is parallel.

### 5. Join and Observation Semantics

Proposed surface:

```voyd
let task = task::spawn(() => work())
let outcome = task::join(task)
```

`join(...)` rules:

- if the task is already terminal, `join` resolves from ready work without
  requiring a fresh external event
- otherwise the current task suspends until the joined task becomes terminal
- `join` preserves the distinction between `value`, `failed`, and `cancelled`

The proposal intentionally favors an explicit outcome type over collapsing
everything into throws. The runtime already models cancellation distinctly, and
the language surface should keep that distinction visible.

Possible surface type:

```voyd
pub enum TaskOutcome<T>
  Value(T)
  Failed(TaskError)
  Cancelled
```

Exact spelling can change, but the three-way outcome should remain.

### 6. Ownership and Structured Concurrency

Structured concurrency should be the default.

Default `spawn(...)` behavior:

- child task is owned by the current task or current task group
- parent cancellation cancels attached children
- parent completion waits for attached children to become terminal
- parent cannot silently abandon attached children

This is stricter than raw JS promises on purpose. It keeps std APIs honest and
prevents accidental background work from leaking out of a scope.

Proposed group surface:

```voyd
task::with_group() |group|
  let left = group.spawn(() => fetch_left())
  let right = group.spawn(() => fetch_right())

  let a = group.join(left)
  let b = group.join(right)
  Pair { left: a, right: b }
```

Group rules:

- all spawned children are siblings under the group
- cancelling the group cancels unfinished children
- group completion waits for all children
- first child failure cancels unfinished siblings by default

The default "fail fast, cancel siblings" policy is a better fit for structured
Voyd work than JS's "everything is independent unless manually observed."

### 7. Detached Work

Detached work should exist, but only explicitly.

Proposed surface:

```voyd
let handle = task::detach(() =>
  write_metrics()
)
```

`detach(...)` rules:

- creates a task in the current run
- re-parents the task from the current owner to the run
- allows the task to outlive the creating task
- still returns a handle that can be cancelled or observed if retained

Failure rules for detached tasks:

- if a detached task is joined, its exact terminal outcome is observed normally
- if a detached task fails without being observed, the failure is reported to a
  runtime-level unhandled-task sink
- unobserved detached failure does not retroactively fail unrelated tasks

This is the closest analog to unawaited Promise or timer callback failure in
JS, but made explicit at the API boundary.

### 8. Run Liveness

A run stays alive while it has live owned work.

A run is complete only when all of the following are true:

- the root task is terminal
- no attached child tasks remain live
- no detached tasks remain live
- no timers or host completions owned by the run can still resume tasks

This is intentionally Node-like: pending timers/background work keep the run
alive.

Future extension:

- add an `unref`-style capability for work that should not keep the run alive

That should be a later feature, not part of the MVP.

### 9. Cancellation Semantics

Cancellation must stay explicit and distinct from failure.

Rules:

- cancelling a task is terminal and idempotent
- cancelling a parent cancels attached descendants
- cancelling a group cancels all live members
- cancelling the run cancels every live task and timer owned by the run
- late host completions for cancelled tasks are ignored

Detached tasks are only cancelled by:

- explicit cancellation through their handle
- root run cancellation
- future runtime shutdown policies

This matches the current host runtime spec and extends it into the language.

### 10. Failure Propagation

Structured and detached work should differ here.

For attached child tasks:

- a failed child records a terminal failed outcome
- joining the child observes that failure directly
- if the parent or group exits without observing the failure, the owner fails
  with an unhandled-child-task failure after cancelling unfinished siblings

For detached tasks:

- failure stays on the detached task handle if observed
- otherwise the runtime reports it to the unhandled-task sink

This keeps structured code safe by default while still supporting intentional
background work.

### 11. Capture and Lifetime Rules

Task captures need explicit rules so the design does not punch holes through
Voyd's ownership model.

Phase 1 recommendation:

- spawned and detached task bodies may capture **owned** values
- immutable globals are allowed
- borrowing stack locals across a task boundary is rejected
- mutable borrowed captures are rejected

That keeps the first implementation tractable and avoids implicit shared-mutable
state between interleaved tasks.

Future work can expand this once Voyd has a clearer escaping-closure and borrow
story.

### 12. Proposed Library Surface

This is illustrative rather than final parser-ready syntax:

```voyd
pub mod task
  pub obj Task<T>
  pub obj TaskGroup
  pub enum TaskOutcome<T>
    Value(T)
    Failed(TaskError)
    Cancelled

  pub fn spawn<T>(work: fn() -> T) -> Task<T>
  pub fn detach<T>(work: fn() -> T) -> Task<T>
  pub fn join<T>(task: Task<T>) -> TaskOutcome<T>
  pub fn cancel<T>(task: Task<T>) -> bool
  pub fn yield_now() -> Unit
  pub fn with_group<T>(body: fn(group: TaskGroup) -> T) -> T
```

Likely later additions:

- `Task::is_done()`
- `Task::outcome_now()`
- `TaskGroup::spawn(...)`
- `TaskGroup::cancel()`
- `TaskGroup::wait_all()`

No `worker` API is included here on purpose. `worker` should remain available
for a future parallel/threaded design rather than becoming an alias for
event-loop tasks.

## Timers Build On Tasks

### Keep Sequential Sleep

`time::sleep(...)` remains the sequential suspension primitive for the current
task. It should not imply spawning.

### One-Shot Timeout

Proposed timeout convenience:

```voyd
let timeout = time::set_timeout(
  after: Duration::from_secs(5),
  task: () =>
    refresh_cache()
)
```

Semantics:

- `set_timeout` creates a detached task owned by the run
- that task waits for the delay
- after the delay it runs the callback body as normal task work
- cancelling the returned handle prevents future execution if the callback has
  not started yet

Equivalent desugaring:

```voyd
task::detach(() =>
  time::sleep(delay)
  callback()
)
```

### Repeating Interval

Repeating work should expose overlap policy explicitly.

Proposed surface:

```voyd
let interval = time::set_interval(
  every: Duration::from_secs(1),
  overlap: Overlap::serial(),
  task: () =>
    sync_once()
)
```

Recommended overlap policies:

- `serial`: never run more than one callback instance at a time
- `concurrent`: each tick may create a new task even if a prior callback is
  still live
- `skip_if_running`: drop ticks while the callback is live
- `buffer_one`: remember at most one pending tick while the callback is live

Recommendation:

- callback interval APIs should default to `serial`
- Node/JS-like behavior should be available explicitly through `concurrent`

This keeps the default safe while still supporting a familiar JS-style mode.

### Interval as a Lower-Level Primitive

The lower-level primitive should likely be "tick delivery" rather than
"callback registration." That keeps the task model fundamental and timers as
composition.

Possible future shape:

```voyd
let ticks = time::interval(every: Duration::from_secs(1))
```

High-level callback helpers can then build on top of that.

## Mapping to the Existing JS Host

This design intentionally reuses the current host architecture.

Today:

- one `VoydRunHandle` represents one managed host run
- the runtime scheduler tracks one continuation chain per run

With this proposal:

- one `VoydRunHandle` still represents one managed host run
- each run owns multiple in-language tasks
- the ready queue holds runnable tasks rather than only runnable runs
- task join/cancellation bookkeeping becomes a run-internal concern

That means the public host API can stay small while the runtime grows a richer
internal task registry.

Needed runtime work:

- per-run task table and task ids
- owner links and cancellation propagation
- join wait lists
- detached-task tracking for run liveness
- timer ownership tied to task/run identity
- runtime hook for unhandled detached-task failures

## Future Multithreading Compatibility

This design should be treated as the semantics for a **single run executor**,
not as a permanent statement that all Voyd concurrency everywhere is
single-threaded.

The intended compatibility path is:

- a run remains an isolation and scheduling boundary
- tasks remain same-run concurrency units
- future workers provide thread-backed parallelism
- workers communicate through explicit host/runtime channels, message passing,
  transferred ownership, or other sendable-value rules

The key compatibility rule is:

- `task::spawn(...)` must not silently gain thread-parallel behavior later

If Voyd adds multithreading, it should do so with distinct APIs and types, for
example:

```voyd
let task = task::spawn(() =>
  refresh_cache()
)

let worker = worker::spawn(() =>
  build_search_index()
)
```

Where:

- `Task<T>` stays cooperative and same-run
- `Worker<T>` represents work executing on another thread

That preserves correctness expectations for captures, cancellation, failure
propagation, and data-sharing rules.

## Draft Spec

The following rules should become normative once the design is accepted.

### Terms

- **Run**: one host-started event-loop instance and all tasks owned by it
- **Task**: one concurrent unit of Voyd work within a run
- **Owner**: the task, group, or run responsible for a task's lifetime
- **Detached task**: a task owned by the run instead of another task

### Ordering

For a single run:

1. No two tasks may execute simultaneously.
2. A task runs until return, failure, cancellation, or suspension.
3. `spawn(...)` must schedule child execution asynchronously, not inline.
4. Ready work created during a scheduler turn must be eligible before the run
   waits for unrelated new external events.
5. Timer and host completions re-enter through the run scheduler, not by
   directly invoking wasm outside the event loop.

### Ownership

1. Every live task has exactly one owner.
2. Attached child tasks are owned by a parent task or group.
3. Detached tasks are owned by the run.
4. Parent completion must not discard live attached children silently.

### Cancellation

1. Cancellation is terminal and idempotent.
2. Run cancellation cancels every live task in the run.
3. Parent cancellation cancels attached descendants.
4. Late completions for cancelled tasks must be ignored.

### Failure

1. `failed` and `cancelled` are distinct terminal outcomes.
2. Joining a task must preserve that distinction.
3. Unobserved failure of an attached child must fail its owner before the owner
   can complete successfully.
4. Unobserved failure of a detached task must be reported to a runtime-level
   sink.

### Timers

1. Timer deadlines must use monotonic time.
2. Timer callbacks must schedule task work through the same run event loop.
3. Timer convenience APIs must document their overlap policy explicitly.

## Suggested Implementation Sequence

### Phase 1: Runtime Model

- extend the scheduler from "one continuation chain per run" to "many tasks per
  run"
- keep `VoydRunHandle` as the root host handle
- add cancellation propagation and detached-task liveness

### Phase 2: `std::task` MVP

- add `Task<T>`
- add `spawn`, `join`, `cancel`, `yield_now`
- initially restrict task bodies to capture-free callables or explicit owned
  captures if closure lifting is not ready

### Phase 3: Structured Groups

- add `TaskGroup`
- add fail-fast sibling cancellation
- add smoke tests for structured cancellation/failure behavior

### Phase 4: Timer Convenience APIs

- add `time::set_timeout`
- add `time::set_interval` with explicit overlap policy
- keep `sleep` as the simple sequential primitive

## Recommendation

Adopt this direction:

- **Node/JS-like event loop semantics**
- **structured concurrency by default**
- **explicit detached work when needed**

That combination fits the current host runtime, keeps std APIs honest, and
avoids baking timer quirks into the language surface before the core task model
exists.
