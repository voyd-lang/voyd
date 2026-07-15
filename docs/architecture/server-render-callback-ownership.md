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
   host records each new id in the active scope, or marks it as eligible to be
   claimed later by a render in the same pure invocation or task.
3. The rendering helper claims eligible ids found in a prebuilt view, then the
   contracted call closes the scope after HTML serialization and releases the
   ids owned by that render.
   `hydrated_document` and `hydrated_html_response` keep hydration serialization
   inside the same boundary.
4. The host closes unfinished scopes when an invocation or task fails or is
   cancelled. Eligible callbacks that are not claimed by a server render remain
   caller-owned, so browser callbacks stay retained until their renderer or
   program lifecycle releases them.

Scopes are keyed by invocation/task owner rather than by ambient asynchronous
state. Concurrent or interleaved tasks therefore cannot claim each other's
callbacks. Nested scopes have independent id sets and closing one scope releases
only its ids.

## What The Scope Owns

Ownership is recorded when the callback registry creates a new id inside the
active scope or when the renderer finds an eligible id in a prebuilt VNode.
Eligibility is tracked by the render-specific retention path, so walking the
VNode cannot claim explicit caller-owned ids. This distinction keeps the
following contracts separate:

- Closure-backed event helpers create render-eligible retained ids. An active
  server render owns them immediately; a later render in the same invocation or
  task claims only the eligible ids present in its VNode.
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
separately. Cleanup failure after an otherwise successful pure invocation or
effectful task surfaces as that invocation or task's failure.
