# Building Voyd Orbit

This is a record of building a substantial browser-to-filesystem application in
Voyd on 2026-08-07. It covers the choices that shaped the example, the parts of
Voyd that worked especially well, and the rough edges that became visible only
after using the language across several boundaries at once.

## 1. Mapping the available platform

The first step was reading the language quick reference, the existing
mini-wikipedia example, VX's browser runtime, the Web router, and the standard
library implementations for HTTP, JSON, filesystem, random bytes, and time.
That survey found a credible full-stack path already present:

- Voyd can server-render the same typed VX tree that the browser hydrates.
- The HTTP client and server both expose effect-backed APIs, so failures remain
  ordinary Voyd values.
- The Web package provides composable routes and an in-memory request path that
  is practical to test.
- JSON has a real value tree and parser/stringifier rather than requiring a host
  serializer.
- The default host already supplies filesystem, time, random, network, and HTTP
  server effects.

Two small platform gaps blocked the requested product rather than merely making
it less convenient. `std::fs` could not recursively create the data directory or
rename a temporary file, and VX had no typed way to send a Canvas drawing frame
to its browser runtime. Those became reusable platform additions instead of
application-specific JavaScript: `create_dir_all`, `rename`, and a versioned set
of canvas draw primitives implemented by the generic VX host.

## 2. Making the physics a separate product surface

The domain model uses AU, solar masses, and days, with unit suffixes on every
physical field. That small naming discipline did real work. It made the gravity
constant readable and stopped camera pixels, world distances, and velocities
from quietly blending together.

The simulation module is pure and rendering-independent. It calculates all
pairwise accelerations, advances positions with velocity Verlet, recalculates
accelerations, and then advances velocities. Close encounters use Plummer-style
softening. This keeps the result deterministic for a given state and fixed
timestep, avoids the instability of naive Euler integration, and leaves
collisions out of the interaction model.

The six built-in systems were useful engineering fixtures as well as product
content. The quiet planetary system exposed long-term energy drift, the binary
system exercised barycentric velocities, three-body chaos stressed close
approaches, the slingshot and flyby made velocity vectors useful, and the
48-object asteroid belt exercised the intended O(n²) workload.

## 3. Sharing one persistence contract

The browser and server compile the same `PersistedSimulation` type and explicit
version-1 JSON codec. The wire document contains durable simulation and camera
state while deliberately excluding selection, open panels, trails, playback
accumulators, and other ephemeral UI state.

The repository treats the filesystem as an untrusted boundary:

1. IDs accept only canonical UUID values.
2. The server owns IDs and timestamps for creates and preserves creation time on
   updates.
3. New files use `create_exclusive`; replacements use `write_atomic`, whose
   host implementation writes a same-directory temporary and replaces the
   destination only after the complete payload is ready.
4. Reads validate both the document and the relationship between its ID and
   filename.
5. Listing isolates failures per file, so one corrupt JSON document cannot hide
   valid saves.

The REST layer stays intentionally small: five CRUD routes, JSON content types,
useful status codes, and `{code, message}` failures. Route tests drive the actual
Web `App` through its public in-memory handler while mock effects observe atomic
and exclusive writes, time, and random bytes.

## 4. Building the browser as a Voyd state machine

The client uses one typed model and message enum. Animation frames only provide
elapsed wall time; an accumulator runs the simulation at its fixed physical
timestep with a bounded catch-up loop. Camera position and zoom ease toward
targets, while following a body changes the camera target without changing the
simulation.

Pointer interaction is represented as an enum—idle, panning, dragging a body,
or placing a body—rather than a set of loosely related booleans. Direct creation
uses the requested two-stage gesture: click for position, drag for velocity, and
show the proposed vector before committing. The inspector edits the same typed
body data, and HTTP results are success/failure enums that keep the simulation
usable when the network or server rejects a request.

The Canvas renderer receives only the model and emits a typed, versioned draw
frame. It layers an adaptive reference grid, fading trails, velocity arrows,
selection rings, labels, and distinct treatments for stars, rocky bodies, and
black holes. Logical CSS-pixel coordinates are converted to high-DPI backing
coordinates by the reusable VX runtime, so application physics never sees a
device pixel ratio.

## 5. Testing the useful contracts

Tests are concentrated at boundaries where a regression would matter:

- vector algebra, softened acceleration, integration, momentum, and bounded
  long-run energy drift;
- versioned simulation and summary JSON round trips;
- ID, color, duplicate-body, and persistence validation;
- safe rooted paths and 128-bit random identifiers;
- REST status/error contracts and create/read/update/delete behavior;
- atomic write ordering and corrupt-file isolation;
- the generic filesystem and Canvas host bindings added to the platform.

The larger asteroid scenario remains product content instead of becoming a
brute-force test. The physics tests use representative bodies and invariants,
which are cheaper and more diagnostic.

## What felt good

Voyd's effect rows made the server design unusually honest. A function touching
the filesystem, clock, random source, browser HTTP client, or task runtime says
so in its signature. The same mechanism made REST tests deterministic without a
separate dependency-injection framework.

Value types, enums with payloads, pattern matching, named argument groups, and
typed JSX were enough to model a nontrivial interactive tool without stringly
typed state. Compiling shared source into both WebAssembly and the server made
the “shared contract” literal rather than conventional.

The Web `App.handle` boundary was especially effective. It allowed real routing
and response behavior to be tested without opening a socket, while effect
handlers still observed the repository's host calls.

## Friction and improvement opportunities

These are ordered roughly by how much they affected the work.

### Guarantee once-only callback evaluation

The live save flow uncovered the most consequential compiler issue in the
project: one click created two files. A retained callback returning a VX
`Program` was evaluated once while checking the callback result's nominal type
and again while loading its payload. Each evaluation started its own detached
HTTP task, so every save, list, duplicate, and delete request ran twice. Value
lowering now evaluates each source expression once, stores its result, and
replays only the stored value while constructing tuples, unions, and other
multi-lane values. Compiler regressions cover effectful nested shapes before
and after optimization, and the Orbit integration regression asserts exactly
one fetch per action.

### Preserve types across asynchronous task results

Once duplicate execution was fixed, direct `Cmd.task` results exposed a second
compiler boundary bug. Unrelated enums share an erased WebAssembly reference
type, and Wasm GC canonicalizes structurally identical wrapper structs. The
outcome encoder had treated each wrapper as a distinct runtime type, so a custom
result such as `SimulationResult` could reach an `unreachable` branch and leave
the UI waiting for a completion message.

Typed outcome boxes now carry an explicit type marker, and the encoder checks
the wrapper shape before reading that marker. The integration fixture returns a
custom enum with a payload, while Voyd Orbit's list, save, load, duplicate, and
delete commands all pass their result enums directly—there is no manual
MessagePack bridge in application code. Outcome encoding, oversized payload,
and decoding failures now settle the host task with a surfaced error instead of
leaving the UI permanently busy; observers reuse that same terminal result.

### Derive boundary serializers from Voyd types

Voyd now derives MessagePack codecs for closed records, arrays, optional fields,
and enum payloads. Field spellings and variant names remain the inspectable wire
contract, while versioned records opt in with an ordinary `version` field.
Unsupported or discriminator-ambiguous shapes fail at the codec call during
compilation.

VX's Canvas implementation now uses private typed records for gradients, path
segments, draw operations, and version-2 frames. Orbit still uses the same typed
Canvas constructors and browser wire format, while the repeated map allocation
and string-key plumbing has disappeared from that production boundary.

### Add strict, composable JSON decoding

Voyd's JSON layer now derives strict structural decoding from ordinary records,
arrays, optional fields, and tagged unions. Failures retain a rooted field path,
unknown fields follow an explicit strict or permissive policy, and versioned
documents require a migration callback that rejects unsupported versions.

Orbit's readable v1 simulation and summary format is unchanged, but its readers
now decode private typed wire records. The handwritten field helpers and their
silent zero, empty-string, and default-object fallbacks are gone. A malformed
body reports the exact `$.bodies[index].field`, while repository listing still
isolates that corrupt file from valid sibling documents.

### Filesystem transactions now expose portable outcomes

Orbit uses `create_exclusive` for new documents so concurrent creators produce
one winner, and `write_atomic` for replacements. Temporary files stay beside
their destination and are cleaned up after failed writes or renames where the
host permits it. Repository errors branch on portable not-found, conflict,
permission, and generic I/O kinds while preserving host detail, so server
behavior no longer depends on platform-specific messages.

### IDs, timestamps, and numbers now share standard contracts

Saved-system IDs come from `Uuid::v4()` and are parsed before becoming path
components; deterministic tests still inject the secure-random effect. Saved
timestamps use the UTC RFC 3339 parser/formatter, including structured calendar
and offset failures. Metric and inspector labels use locale-independent fixed,
significant, and scientific formatting with explicit rounding, trailing-zero,
and non-finite policies. Orbit no longer carries local entropy, date, or decimal
conventions.

### Numerical failures now carry useful context

The gravity, integration, and conservation tests use
`std::test::numeric::assert_close` with explicit absolute and relative
tolerances. Failures report the expected and actual values, delta, tolerances,
the caller's context message, and the test source location. Equal infinities and
signed zero pass; NaN, unequal infinities, and invalid tolerances fail. The local
boolean `close` helper is gone.

### Generated identifiers now compose without collisions

Macro-created bindings now carry deterministic identities independent of their
readable labels. Reusing `Loaded` and `Failed` across result enums is safe, each
enum exposes its variants through its own namespace, and fresh implementation
symbols cannot leak through public expansion visibility. Compiler-inserted JSX
helpers resolve through explicit standard-library identities, so component
props cannot shadow them. Orbit's `NumberField` prop has therefore returned to
the natural `value` name.

Generated-syntax diagnostics point to the macro invocation and retain the
definition location as related context. Navigation and rename follow each
generated binding back to its visible allocation syntax, while the private
identity stays out of AST output, metadata, ABI, and Wasm names. The multiline
server predicate also uses its original readable boolean chain now that
continuation operators preserve the following indented operand.

### Make package boundaries easier to stage

`shared`, `simulation`, `client`, and `server` now use deliberate nested source
packages. Each folder owns a `pkg.voyd`; outside code imports only the logical
package path and consumes that root's curated exports. The old top-level
`shared.voyd`, `simulation.voyd`, `client.voyd`, and `server.voyd` facade
workaround is gone. `client/pkg.voyd` is also the browser compile entrypoint,
while `main.voyd` remains the server program.

The compiler now preserves nominal, overload, operator, trait, macro, and
generated-declaration metadata through those roots. Diagnostics distinguish a
module-private declaration, a package-private declaration, a hidden nested
internal, a missing `api` member, and an omitted operator or macro import, and
they point to the package root that can repair the boundary. A folder can be
staged as an ordinary facade until isolation is wanted, then migrated by moving
the facade to `foo/pkg.voyd`; the compiler rejects leaving both logical-path
owners in place.

### Effect names and test captures are explicit

Voyd now resolves a qualified effect operation from its effect identity before
considering ordinary functions. Orbit imports `std::fs` for typed wrappers and
`std::fs::Fs` for handler clauses, so `fs::rename(...)` and
`Fs::rename(...)` can keep their natural names without local aliases. Saved IDs
come from `Uuid::v4()`, which obtains and validates 16 secure bytes through the
standard random effect instead of assembling normalized integer samples.

The REST tests exposed a steep borrow-rule corner: an effect continuation cannot
receive a value through an active mutable borrow. The compiler now identifies
the captured value and continuation boundary and recommends an owned snapshot,
an immutable fixture, or `SharedCell` according to the situation. The effects
reference includes a complete mock-host pattern. Orbit follows it directly:
read payloads are immutable fixtures, changing write observations live in
`SharedCell`, and every cell callback ends before `tail` runs.

### Form properties now fail before the first request

The first real page request exposed a mismatch between an option's HTML value
attribute and VX's live DOM `value` property. Built-in JSX now checks the tag as
it lowers form syntax: option values become ordinary attributes, while input
and textarea values remain controlled properties. Unsupported combinations
point to the attribute and suggest the stable form—for example, `selected` on
the matching option instead of `value` on a select. The scenario picker uses
idiomatic typed `<option value={...} selected={...}>` syntax, and browser and
server rendering consult the same property-representation contract.

### Make constructor and multiline diagnostics more direct

Voyd now keeps indented operands after boolean and arithmetic continuation
operators in the same expression. Orbit's server error classifier is back to a
single readable multiline predicate instead of a sequence of early-return
workarounds. When type-call construction does not match a `val` initializer,
the diagnostic points at the type and suggests its explicit `Type::init(...)`
API; Orbit continues to use `Vec2::init(...)` as the idiomatic spelling.

### Canvas graduated into VX's documented core

The first Orbit renderer exposed only lines, polylines, circles, ellipses, text,
glow, and radial fills. VX now provides typed paths, affine transforms, balanced
save/restore scopes, line dashes, compositing, and explicit text measurement
results. The expanded draw grammar is Canvas frame version 2; the browser still
validates legacy version-1 frames. It validates each complete frame before
mutating the target and owns high-DPI backing-store scaling while Voyd stays in
logical CSS pixels.

Orbit exercises the completed surface in production: velocity arrows are
transformed paths, its measured title drives a path-backed, dashed, and
composited overlay, and active-pointer tracking plus pointer capture keeps pan,
drag, and placement gestures coherent outside the canvas until release or
cancellation. The Canvas MessagePack wire records are compiler-derived from typed
records, with their explicit version and established field names covered by the
VX boundary regressions.

### Compose reusable effect-host policy with `with_*`

Adding filesystem operations correctly forced every closed `Fs` handler to
account for them. Orbit now centralizes that exhaustive, operation-specific
policy in `with_mock_host`. Individual tests use an inner `try open` only when
they need to override one operation, and every unmatched operation propagates
to the reusable outer handler.

This keeps heterogeneous operation result types fully typed and preserves the
useful compile-time signal when `Fs` grows, without adding a dynamically typed
fallback clause. The [effects reference's reusable `with_*` handler
guidance](../../packages/reference/docs/types/effects.md#reusable-with_-handlers)
explains when to use a policy-bearing function and when a small inline handler
is clearer.

## Bottom line

The main surprise was not that the gravity math could be written in Voyd; it was
that the mundane full-stack edges could be kept there too. The completed path is
browser gesture → typed message → simulation and Canvas frame → shared JSON
→ HTTP → validated route → atomic filesystem write, with Voyd owning every
application decision along the way. The remaining roughness is concentrated in
ergonomics around boundaries and diagnostics rather than a missing architectural
capability.
