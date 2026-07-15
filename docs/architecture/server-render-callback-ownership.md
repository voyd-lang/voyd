# Server Render Callback Ownership

Closure-backed VX event helpers cross the Wasm boundary when a view is built.
The JS host retains the closure and returns a numeric handler id stored in the
VX descriptor. Browser rendering needs that callback for the mounted renderer's
lifetime, while server rendering only needs to construct HTML and must not leave
the callback in a long-running host.

## Ownership Boundary

Server rendering uses a composed std/web/host boundary:

1. Compiler contracts on the resolved `pkg::web` rendering helpers open an
   internal scope before evaluating their arguments, so a direct
   `document(view(model))` call needs no request-server wrapper. Resolution is
   symbol-based: aliases and qualified calls are covered without rewriting
   unrelated functions that happen to share a helper name.
2. Closure-backed VX event helpers use a render-specific retention import. The
   host records each new id in the active scope for the current pure invocation
   or task.
3. The contracted call closes the scope after HTML serialization and releases
   exactly the ids created while evaluating and rendering that call.
   `hydrated_document` and `hydrated_html_response` keep hydration serialization
   inside the same boundary.
4. The host closes unfinished scopes when an invocation or task fails or is
   cancelled. Render-specific callbacks retained without an active server scope
   remain caller-owned, so browser callbacks stay retained until their renderer
   or program lifecycle releases them.

Scopes are keyed by invocation/task owner rather than by ambient asynchronous
state. Concurrent or interleaved tasks therefore cannot claim each other's
callbacks. Nested scopes have independent id sets and closing one scope releases
only its ids.

## What The Scope Owns

Ownership is recorded only when the callback registry creates a new id inside
the active scope. The renderer does not walk the resulting VNode looking for
handler ids. This distinction keeps the following contracts separate:

- Closure-backed event helpers create retained ids owned by an active server
  render scope. When no scope is active, those ids remain caller-owned for
  browser mount or another explicit lifecycle.
- Static-message event descriptors embed a message and create no retained id.
- Explicit stable handler ids and mapped handler ids are never observed through
  the render-retention import. Subscription, command, and program callbacks use
  separate retention imports and remain owned by their caller or runtime.

Browser mount and hydration do not call the server renderer. Their retained
callbacks continue to be released by VX DOM detach/dispose and program lifecycle
logic.

## Failure Semantics

View evaluation, HTML serialization, and (for the hydrated helpers) hydration
serialization all happen inside the render scope. A trap during any of those
steps terminates the invocation/task, whose cleanup releases unfinished scopes
and their render-specific callbacks. If registry cleanup also throws, the
original failure is preserved and the host reports the cleanup failure
separately. Explicit successful cleanup failures surface as invocation/task
failures.
