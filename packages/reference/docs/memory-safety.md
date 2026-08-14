---
order: 80
---

# Memory Safety

Full-stack applications keep data alive across request handlers, callbacks,
component updates, caches, and asynchronous work. The difficult bugs usually
come from two questions:

1. Is the data still alive?
2. Can this code safely read or change it right now?

Voyd answers the first question with garbage collection and the second with
checked access. Ordinary values stay convenient to pass around. Mutation is
explicit, genuine storage views are visible in types, and intentionally shared
mutable state uses a scoped runtime abstraction.

Together, these rules prevent source-level use-after-free and double-free bugs,
conflicting alias mutation, escaped views into request storage, invalidated
iterator results, and accidental reuse of mutable buffers.

## The model in six rules

1. Garbage collection keeps reachable allocations alive.
2. Shared reads may coexist, but an active writer may not overlap another
   active access to the same storage.
3. A plain `T` is a value, never a hidden source-level borrow.
4. Copying an object handle preserves object identity without borrowing the
   slot from which the handle was read.
5. `Borrow<T>` lends shared access only for the duration of a call.
6. A scoped borrow cannot be returned, stored, captured, suspended, or hidden
   inside another type.

## Lifetime and access are separate

Garbage collection keeps an allocation alive while ordinary values, objects,
closures, or tasks can still reach it. Voyd source does not manually free GC
objects, so an ordinary captured object cannot become a dangling pointer.

```voyd
obj Session {
  user_id: i64,
  request_count: i32
}

fn record_request(~session: Session) -> void
  session.request_count = session.request_count + 1

let ~session = Session { user_id: 42, request_count: 0 }
let audit_view = session

record_request(~session)
print(audit_view.request_count) // 1
```

`session` and `audit_view` are handles to the same `Session` allocation. Either
handle keeps the allocation alive. Copying the handle does not copy the object
and does not create a permanent shared borrow.

Garbage collection does not prevent logical retention leaks. An unbounded
cache, subscription table, or long-lived closure can keep data reachable
forever. Applications must still remove entries and listeners they no longer
need; the guarantee is that retained data remains valid, not that every
retention policy is bounded.

Access checking answers a different question: whether reads and writes may
overlap. Sequential mutation followed by observation is valid, as above. A
simultaneous read and write through aliases is rejected.

This separation is useful in web applications: handlers and background tasks
can retain ordinary objects naturally, while APIs that expose mutable storage
remain tightly scoped.

## Binding mutability and object mutation

Voyd distinguishes changing what a name refers to from changing an object.

Use `var` when a binding must be reassigned:

```voyd
var status = 200

if validation_failed:
  status = 422
```

An ordinary `let` binding cannot be reassigned:

```voyd
let status = 200
// status = 422 // error: `status` is not reassignable
```

Use `~` when code needs mutable access to an object:

```voyd
obj Response {
  status: i32,
  body: String
}

let ~response = Response { status: 200, body: "" }
response.status = 201
```

Functions and methods must request mutable access explicitly:

```voyd
fn reject(~response: Response, status: i32) -> void
  response.status = status
  response.body = "request rejected"

impl Response
  fn set_body(~self, body: String) -> void
    self.body = body
```

Without `~`, mutation is rejected. A function that only receives
`response: Response` cannot unexpectedly modify it through that parameter.

`~` grants temporary exclusive capability. It does not move the value, free
the allocation, or transfer ownership.

### Module scope

Module-level `let` declarations are allowed, including exported constants:

```voyd
let default_page_size = 50
pub let api_version = "v1"
```

Mutable object bindings are local-only. Module-level `let ~state = ...` is not
supported. Long-lived application state with multiple owners should use an
explicit abstraction such as `SharedCell<T>` rather than implicit mutable
global state.

## Shared and exclusive access

Ordinary access is shared and read-only. Mutable access through `~` is
exclusive for the storage a call actually uses.

Consider a response helper that reads one header collection while updating
another:

```voyd
obj Headers {
  values: Array<String>
}

fn copy_headers(source: Headers, ~destination: Headers) -> void
  // ...

let ~headers = Headers { values: Array<String>::init() }
copy_headers(headers, ~headers)
// error: shared and mutable access overlap
```

Without this check, `copy_headers` could iterate `source` while growing or
replacing the same collection through `destination`, producing skipped entries,
duplicate entries, or reads from invalidated storage.

Two writes to the same object are rejected for the same reason:

```voyd
fn merge_sessions(~from: Session, ~into: Session) -> void
  // ...

merge_sessions(~session, ~session)
// error: two exclusive accesses overlap
```

Multiple shared reads may coexist. Mutation is allowed again when the earlier
access has ended.

## Mutable reborrows end after their final use

Voyd infers the duration of a local mutable reborrow from its uses rather than
from the surrounding lexical block. This is often called non-lexical lifetime
analysis.

```voyd
obj RequestContext {
  trace_id: String,
  response: Response
}

let ~context = RequestContext {
  trace_id: "request-42",
  response: Response { status: 200, body: "" }
}

let ~draft = context.response
draft.set_body("ok")
// `draft` is not used again, so its reborrow has ended.

context.response = Response { status: 204, body: "" }
```

A later use keeps the reborrow active:

```voyd
let ~draft = context.response
context.response = Response { status: 204, body: "" }
// error: replacing the source conflicts with the live reborrow
draft.set_body("still in use")
```

This protects against a common invalid-reference bug while avoiding artificial
scope blocks or explicit lifetime annotations. A `Borrow<T>` call parameter is
different: it remains active for the complete invocation, including any nested
calls made with that parameter.

## Plain values and object aliases

A plain `T` is a semantic value. Assignment, argument passing, return,
aggregate construction, and closure capture do not borrow the source slot.

- Scalars are copied.
- `val` values are logically copied.
- Object handles are copied cheaply and preserve object identity.
- Aggregates are logically copied according to their fields.
- Object handles inside copied values remain aliases to their allocations.

Value types are useful for request data that should be independent after it is
copied:

```voyd
val Page {
  number: i32,
  size: i32
}

var requested = Page { number: 1, size: 50 }
let logged = requested
requested = Page { number: 2, size: 50 }

print(logged.number) // 1
```

Objects are useful when several parts of an application intentionally share
identity:

```voyd
obj UserSession {
  authenticated: bool
}

let ~session = UserSession { authenticated: false }
let middleware_session = session

session.authenticated = true
print(middleware_session.authenticated) // true
```

The ordinary alias does not freeze `session`. Only an active access or scoped
borrow can conflict with mutation.

The compiler may represent a plain value with an internal readonly borrow as
an optimization. It must materialize the value before that representation
could affect accepted source programs. Internal borrowing never appears in a
source type or public API contract.

## Component state snapshots cannot be mutated accidentally

A common React bug is modifying state through an alias and then passing the
same object back to the framework:

```tsx
const addTodo = (todo) => {
  const next = todos;
  next.push(todo);
  setTodos(next);
};
```

`next` and `todos` are the same array. The code mutates previous render
snapshots, React may skip rendering because the identity did not change, and
memoized children or retained closures can observe surprising data.

Voyd rejects the equivalent mutation:

```voyd
obj Model {
  todos: Array<Todo>
}

fn add_todo(model: Model, todo: Todo) -> Model
  model.todos.push(todo)
  // error: `model.todos` does not have mutable access
```

`Array.push` requires mutable `~self` access. Component models and props are
ordinary values, so code cannot mutate an earlier snapshot accidentally.
Construct the next model instead:

```voyd
fn add_todo(model: Model, todo: Todo) -> Model
  Model {
    todos: model.todos.pushed(todo)
  }
```

The asynchronous form is even more painful in React:

```tsx
const draft = form;
await save(draft);

draft.status = "saved";
setForm(draft);
```

The user may have edited or replaced `form` while `save` was pending. The
completion can then mutate an obsolete object and restore it over newer input.

Voyd does not allow mutable or explicitly borrowed access to remain live across
a suspension. VX commands return ordinary messages, and `step` applies each
message to the current model. An application still uses a request id or
revision when it needs to ignore an obsolete response, but stale work cannot
silently retain a mutable pointer into component state.

## Places, fields, and referenced allocations

A **place** is addressable storage: a binding, field, tuple position, or stable
container element.

```voyd
context
context.response
pair.0
routes.at(3)
```

The slot holding an object handle and the referenced allocation are distinct:

```voyd
app.cache = replacement // writes the `cache` field slot
app.cache.clear()        // mutates the referenced Cache allocation
```

This distinction prevents a mutation deep inside application state from
unnecessarily locking the entire object graph.

Known-disjoint fields can be accessed independently:

```voyd
obj AppState {
  cache: Cache,
  metrics: Metrics
}

fn refresh(~cache: Cache, metrics: Metrics) -> void
  // Mutates cached data while reading independent metrics.
  // ...

refresh(~app.cache, app.metrics)
```

Indexed elements are conservative when their relationship is unknown. Voyd
either proves them disjoint, inserts the bounded runtime check described below,
or rejects the operation.

## Owned results and scoped borrows

Every callable result is an ordinary value. An iterator, for example, returns
values that remain valid when the cursor advances:

```voyd
trait Iterator<T>
  fn next(~self) -> Option<T>
```

```voyd
let first = iterator.next()
let second = iterator.next()
use(first)
```

Advancing the iterator cannot invalidate `first`. Voyd does not have borrowed
results or borrow-carrying containers. An API that needs zero-copy access lends
that access to a bounded call instead:

```voyd
fn checksum(bytes: Borrow<Bytes>) -> i32
  // Read `bytes` during this invocation.
  // ...

checksum(packet.body)
```

Library APIs can publish a checked result-identity contract when the ordinary
conservative rule is unnecessarily restrictive:

```voyd
@result(detached)
fn parse(~cursor: Cursor) -> Result<Value, ParseError>

@result(fresh)
fn copied(source: Buffer) -> Buffer

fn set(~self, key: Key, value: Value) -> ~self
```

`detached` means the result exposes no mutable identity from an input. `fresh`
means only the returned outer object is new; its elements may still alias input
objects. `-> ~self` transfers the exact exclusive receiver so calls can be
chained without allocation or copying. A same-place result is temporary: use it
immediately in another matching mutable call, return it from another matching
same-place function, or ignore it. It cannot be saved in a plain binding or
converted to an ordinary value.

Unannotated and imported legacy callables remain conservative. These contracts
do not change overload selection or runtime representation.

Library code that deliberately snapshots a possibly overlapping source before
mutation can publish a checked staged contract:

```voyd
@staged(into: self)
fn extend(~self, other: Array<T>) -> void
```

The compiler verifies that all source access finishes before the first write to
`self`. This is intended for collection and byte-buffer primitives; ordinary
application code normally just calls those APIs. Dynamic dispatch, callbacks,
effects, and suspension remain conservative.

Recursive encoders can stream into a locally fresh private builder with a
checked builder contract:

```voyd
@builder(into: output)
fn encode(~output: ByteBuffer, value: Value) -> void
```

The destination must be a unique fresh local, the call target must be exact,
and the compiler checks that the function cannot retain, return, or capture a
reference-bearing source through the builder. This permits normal recursive
streaming while keeping open dispatch, effects, callbacks, suspension, and
non-fresh destinations conservative.

`Borrow<T>` is a compiler-known type constructor with exactly one argument. It
may be the complete type of a callable input, including an input of a nested
function type:

```voyd
fn with_value<T, R>(
  value: T,
  { body: fn(value: Borrow<T>) : () -> R }
): () -> R
  body(value)
```

Passing a plain `T` to a `Borrow<T>` input implicitly forms shared access for
the complete invocation. Passing an existing `Borrow<T>` forms a nested shared
reborrow. `Borrow` is invariant, so its inner type must match exactly after
alias expansion. A borrowed value cannot be passed to a plain `T` input.

A local binding may name the same borrow when it is initialized from an active
borrowed parameter or one of its projections. The local binding cannot extend
the invocation scope.

`Borrow<T>` is rejected as a result, field, tuple or union member, module value,
ordinary generic argument, or nested borrow. A function value whose input is
`Borrow<T>` may be stored or returned: the borrow becomes active only when that
function is called.

### Exclusive scoped access

`~value: Borrow<T>` grants exclusive access to borrowed storage for a callback:

```voyd
fn edit(body: fn(~value: Borrow<Document>) : () -> void) -> void
  // ...
```

Exclusive scoped access can be formed from an exclusive `~T` place, another
`~Borrow<T>`, or a successful `SharedCell<T>` guard. Shared access cannot be
upgraded to exclusive access. An exclusive reborrow suspends its parent until
the nested call returns.

## Scoped data cannot escape into later work

An active `Borrow<T>` cannot be returned, stored, captured by a closure, passed
through a plain parameter, sent to an effect or host boundary, or kept across a
suspension. These rules apply even when the compiler could prove a closure runs
immediately; use a direct helper with an explicit `Borrow<T>` input instead.

```voyd
fn schedule_audit(header: Borrow<Header>) -> void
  let _ = task::detach(() => audit(header))
  // error: a closure cannot capture `header`
```

Copy the required data into an ordinary value before scheduling later work:

```voyd
fn schedule_audit(header: Borrow<Header>) -> void
  let owned_value = header.value.to_string()
  let _ = task::detach(() => audit(owned_value))
```

A borrow also cannot cross a suspension:

```voyd
fn parse_later(body: Borrow<Bytes>) : Async -> Document
  let _ = time::sleep(10)
  parse(body)
  // error: `body` would remain active across suspension
```

Parse or copy the data before suspending. Ordinary object handles may be
captured normally; garbage collection keeps their allocations alive, and
accesses made when a callback runs follow the usual access rules.

## Runtime checks for dynamic element access

Web code often needs to mutate two elements selected at runtime—for example,
moving route precedence entries or transferring items between cart positions:

```voyd
fn swap_entries(~left: RouteEntry, ~right: RouteEntry) -> void
  // ...

swap_entries(~routes.at(left_index), ~routes.at(right_index))
```

If the indices are statically known to differ, no runtime check is needed. If
they are statically equal, the call is a compile error. When the projected
places have stable comparable identities but their relationship is known only
at runtime, Voyd inserts a bounded identity guard.

The guard runs after argument evaluation and before either mutable access is
activated. Equal identities produce a deterministic exclusivity-conflict
panic, so the function never receives two mutable references to the same
entry.

The guard is deliberately call-scoped. It does not install a persistent loan
record or depend on garbage collection for release. Access that cannot remain
bounded is rejected or must use an explicit safe abstraction such as
`SharedCell<T>`.

## Calls and evaluation order

Voyd evaluates calls in a defined order:

1. The receiver is evaluated.
2. Explicit arguments are evaluated in source order.
3. Omitted defaults are evaluated in parameter order.
4. Static checks and required runtime identity guards run.
5. Shared and mutable call accesses are activated.
6. The callable runs.
7. Parameter accesses end when the callable returns.

This means a default can safely read application state before a mutable call
access begins, and every argument or default runs exactly once:

```voyd
fn append_trace(
  ~headers: Headers,
  trace_id: String = current_trace_id()
) -> void
  // ...

append_trace(~response.headers)
```

Optimized and unoptimized code preserve the same order and conflict behavior.

## Bounded call summaries

Voyd checks ordinary calls with small whole-parameter summaries. Each parameter
is classified as unused, read, or written. The summary also records whether the
callable accesses ambient object state, invokes an unknown callback, or may
suspend. It contains no field paths, generic projections, regions, or returned
origins.

For example, this function publishes only that it writes its first parameter:

```voyd
fn update(~state: State) -> void
  state.profile.count = state.profile.count + 1
```

A plain `T` parameter permits at most reading, while `~T` permits writing. Trait
declarations provide the upper bound used for dynamic dispatch, and every
implementation is checked against that bound.

Any callable with a `~T` parameter must also prove that it does not perform
potentially overlapping ambient access, call an unknown callback, or suspend.
This keeps a dynamic mutable call safe without exposing private representation
details. A statically known helper is allowed only when its bounded summary is
compatible with every active exclusive access.

The compiler may keep field- and stable-index detail inside one callable for
local checking. That detail is never part of the public callable summary.

## Shared application state with SharedCell

Use an ordinary `~T` borrow when one owner can lend temporary mutable access.
Use `SharedCell<T>` when several long-lived owners—such as route handlers,
middleware, or component callbacks—must intentionally share mutable state.

```voyd
use std::shared_cell::SharedCell

obj ServerStats {
  requests: i64,
  failures: i64
}

let stats = SharedCell(ServerStats { requests: 0, failures: 0 })

stats.with_mut((~value) =>
  value.requests = value.requests + 1
)

let request_count = stats.with((value) => value.requests)
```

The callback parameter is an explicit scoped borrow:

```voyd
fn with<R>(self, body: fn(value: Borrow<T>) : () -> R): () -> R
fn with_mut<R>(self, body: fn(~value: Borrow<T>) : () -> R): () -> R
```

Multiple shared callbacks may coexist. A mutable callback requires exclusive
access. Overlap produces a deterministic panic; `try_with` and `try_with_mut`
return a typed `SharedCellBorrowError` instead.

The callback cannot return, store, capture, suspend with, or otherwise escape
its borrowed parameter:

```voyd
let escaped = stats.with((value) => value)
// error: the scoped borrow would escape
```

Return an ordinary result such as `value.requests` instead. Callback effect
rows are closed, so perform database, network, timer, or task work before or
after the short access callback.

`SharedCell` is single-threaded. It checks reentrant or overlapping access but
does not block, synchronize threads, or provide cross-thread safety.

## Stable StringSlice values

Strings appear at nearly every web boundary: routes, headers, query values,
JSON fields, and template output. A view tied to a mutable string buffer can
become stale or dangling when the source changes.

Voyd's ordinary `StringSlice` avoids that problem by retaining immutable
backing storage directly:

```voyd
let ~path = "/users/42"
let resource = path.slice(bytes: 1, len: 5)

path.replace(old: "users", with: "accounts")
print(resource) // "users"
```

Mutating `path` replaces its backing handle. Existing slices continue to see
their original bytes and do not block later mutation of the source string.

`StringSlice` is therefore an ordinary stable value, not a hidden source loan.
An API that intentionally exposes a mutable or reusable parsing buffer must
lend it through a scoped `Borrow<T>` callback instead.

## Choosing the right form

| Need                                                        | Use                       |
| ----------------------------------------------------------- | ------------------------- |
| Reassign a local name                                       | `var`                     |
| Temporarily mutate an object with a clear owner             | `~T`                      |
| Pass or return an ordinary independent value                | `T`                       |
| Share the identity of a GC-managed object                   | an ordinary object handle |
| Lend zero-copy shared access for one call                   | `Borrow<T>`               |
| Lend zero-copy exclusive access for one callback            | `~value: Borrow<T>`        |
| Share mutable state among long-lived single-threaded owners | `SharedCell<T>`           |
| Keep an immutable view of text across source mutation       | `StringSlice`             |

Prefer ordinary values and handles for application code. Reach for scoped
borrows only when an API genuinely needs bounded zero-copy access.

## Current scope

This guide describes the memory-safety guarantees of ordinary Voyd source and
same-event-loop task concurrency.

The current model does not yet define arbitrary raw linear-memory access,
unsafe facilities, host-language FFI safety, or multithreaded transfer and
synchronization. Safe APIs at those boundaries need explicit rules before they
can extend the guarantees described here. Future FFI and multithreading rules
belong under this broader memory-safety model.

For the precise language and compiler requirements, see the
[Memory and Mutation Safety specification](https://github.com/voyd-lang/voyd/blob/main/docs/specs/memory-and-mutation-safety.md).
