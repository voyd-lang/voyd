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
5. A genuine storage view uses `borrow T` and carries its origin.
6. Advanced APIs can describe access and borrowed results with checked regions
   and `@borrow_contract`.

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

## Borrows end after their final use

Voyd infers borrow duration from use rather than from the surrounding lexical
block. This is often called non-lexical lifetime analysis.

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
scope blocks or explicit lifetime annotations.

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

The ordinary alias does not freeze `session`. Only an active access or explicit
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

## Owned results and borrowed views

Most application APIs should return ordinary values. An ordinary iterator, for
example, returns values that remain valid when the cursor advances:

```voyd
trait Iterator<T>
  fn next(~self) -> Option<T>
```

This pattern is safe:

```voyd
let first = iterator.next()
let second = iterator.next()
use(first)
```

Advancing the iterator cannot invalidate `first`. This avoids the familiar bug
where a cursor returns a pointer into a buffer that is overwritten on the next
iteration.

Use `borrow T` when an API intentionally returns a zero-copy view into storage
owned elsewhere:

```voyd
obj Header {
  name: String,
  value: String
}

fn header_at(request: Request, index: i32) -> borrow Header
  // Returns a view into the request's parsed-header storage.
  // ...
```

The result carries its origin. Mutation that could invalidate the view is
rejected until the view's final use:

```voyd
let ~request = parse_request(raw_request)
let authorization = header_at(request, 0)
request.reuse_parser_buffer()
// error: `authorization` still views request storage
authenticate(authorization)
```

Consume the view first and the mutation becomes valid:

```voyd
let ~request = parse_request(raw_request)
let authorization = header_at(request, 0)
authenticate(authorization)
request.reuse_parser_buffer()
```

Borrowed values compose through optionals, results, tuples, structural values,
nominal values, generic wrappers, and pattern matching:

```voyd
fn find_header(request: Request, name: String) -> Option<borrow Header>
  // ...
```

`borrow` applies to the next type, so these have different meanings:

```voyd
Option<borrow Header> // an owned Option whose Some payload is borrowed
borrow Option<Header> // a borrowed view of an Option stored elsewhere
```

A borrowed value cannot be stored somewhere that outlives its origin or passed
through a boundary that erases its origin.

## Borrowed data cannot escape into later work

Request handlers commonly start callbacks or tasks that outlive the current
operation. Voyd prevents those callbacks from retaining a view into temporary
request storage:

```voyd
use std::task

let authorization = header_at(request, 0)

let _ = task::detach(() =>
  audit(authorization)
)
// error: the borrowed header would escape into a task
```

Copy the needed data into an ordinary value before scheduling the work:

```voyd
let authorization = header_at(request, 0).value.to_string()

let _ = task::detach(() =>
  audit(authorization)
)
```

An explicit borrow or mutable reborrow also cannot cross a suspension that may
resume later:

```voyd
use std::time

let body = request.borrow_body()
let _ = time::sleep(10)
parse(body)
// error: `body` remains live across suspension
```

Parse or copy the data before suspending. Ordinary object handles may be
captured normally; their allocations remain alive through garbage collection,
and accesses made when a callback runs follow the usual access rules.

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
record or depend on garbage collection for release. Escaping, unstable, or
suspending accesses require a static contract or an explicit safe dynamic
abstraction instead.

## Calls and evaluation order

Voyd evaluates calls in a defined order:

1. The receiver is evaluated.
2. Explicit arguments are evaluated in source order.
3. Omitted defaults are evaluated in parameter order.
4. Static checks and required runtime identity guards run.
5. Shared and mutable call accesses are activated.
6. The callable runs.
7. Non-retained call accesses end when the callable returns.

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

## Borrow contracts for reusable APIs

Concrete functions usually need no annotations; the compiler infers their
caller-visible access. Traits and other representation-hiding boundaries may
declare regions and a `@borrow_contract`.

Consider a cache that updates statistics while returning a zero-copy view of a
stored response:

```voyd
trait CacheView<K, V>
  region entries
  region statistics
  disjoint entries, statistics

  @borrow_contract(
    mutates: statistics,
    returns_from: entries
  )
  fn get(~self, key: K) -> Option<borrow V>
```

An implementation maps those public regions to its private representation:

```voyd
impl CacheView<String, Response> for MemoryCache
  region entries = deref(self.entries)
  region statistics = self.hit_count

  api fn get(~self, key: String) -> Option<borrow Response>
    // ...
```

`deref(place)` names the allocation referenced by a handle slot; it is a
compile-time contract expression, not a runtime function.

The compiler verifies that implementations stay within the declared reads,
writes, returned-borrow origins, and disjointness rules. Calls through a trait
use the declaration contract as their authoritative caller-visible behavior.

Contracts make zero-copy abstractions possible without exposing private fields
or asking every caller to understand the implementation.

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
fn with<R>(self, body: fn(value: borrow T) : () -> R): () -> R
fn with_mut<R>(self, body: fn(~value: borrow T) : () -> R): () -> R
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
An API that intentionally exposes a mutable or reusable parsing buffer must use
an explicit borrowed type instead.

## Choosing the right form

| Need                                                        | Use                            |
| ----------------------------------------------------------- | ------------------------------ |
| Reassign a local name                                       | `var`                          |
| Temporarily mutate an object with a clear owner             | `~T`                           |
| Pass or return an ordinary independent value                | `T`                            |
| Share the identity of a GC-managed object                   | an ordinary object handle      |
| Return a zero-copy view into another value's storage        | `borrow T`                     |
| Share mutable state among long-lived single-threaded owners | `SharedCell<T>`                |
| Describe borrowed behavior through a trait                  | regions and `@borrow_contract` |
| Keep an immutable view of text across source mutation       | `StringSlice`                  |

Prefer ordinary values and handles for application code. Reach for explicit
borrows and contracts when a zero-copy or representation-hiding API genuinely
needs them.

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
