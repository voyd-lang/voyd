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

1. IDs accept only bounded lower-case alphanumeric/hyphen values.
2. The server owns IDs and timestamps for creates and preserves creation time on
   updates.
3. Each write is encoded to a hidden same-directory temporary file and renamed
   over its destination.
4. Reads validate both the document and the relationship between its ID and
   filename.
5. Listing isolates failures per file, so one corrupt JSON document cannot hide
   valid saves.

The REST layer stays intentionally small: five CRUD routes, JSON content types,
useful status codes, and `{code, message}` failures. Route tests drive the actual
Web `App` through its public in-memory handler while mock effects observe writes,
renames, time, and random bytes.

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
HTTP task, so every save, list, duplicate, and delete request ran twice. The
generic callback code generator now uses the statically known payload-envelope
type for a direct field load, and an integration regression asserts one fetch
per action. Effectful expressions must have once-only evaluation semantics;
making this invariant explicit in the IR and testing it across other structural
loads would guard against the same class of bug elsewhere.

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
MessagePack bridge in application code. Longer term, a failed outcome-encoding
step should always settle the host task with a surfaced error; that would have
made this failure immediate instead of presenting as a permanently busy UI.

### Derive a boundary serializer

VX command payloads and some host adapters still construct MessagePack maps by
hand and repeat their string field names. The Canvas extension is typed to Voyd
callers, but its implementation is longer and more fragile than the domain code.
A derived boundary serializer for records, enums, and version tags would make
new host capabilities much smaller while preserving an explicit wire contract.

### Add strict, composable JSON decoding

The JSON value API is capable, but a handwritten decoder needs many tiny
`json_string`, `json_number`, and object/array helpers. Missing and wrong-typed
fields can easily collapse to default values unless every caller adds validation.
Decoder combinators that accumulate a field path—or a derive facility with
version hooks—would improve diagnostics and reduce accidental leniency.

### Round out filesystem transactions

Voyd Orbit added recursive directory creation and rename because safe persistence
needed both. A standard `write_atomic(path, contents)` helper would be a useful
next layer. Longer term, file locking or an exclusive-create primitive would
make concurrent writers easier to reason about. `IoError` is currently coarse,
so distinguishing “not found,” permissions, and transient failures often needs
host-specific interpretation.

### Provide UUIDs and date formatting

Random bytes and epoch milliseconds are sufficient to implement safe IDs and
timestamps, but applications should not each invent those conventions. Standard
UUID/opaque-ID generation and ISO-8601 parse/format APIs would improve both JSON
readability and UI metadata. A compact, locale-independent number formatter
would also help scientific interfaces; raw `to_string(f64)` is not an ideal
inspector display.

### Improve numerical test assertions

The test library has equality assertions but no `assert_close`, tolerance, or
custom failure message. Physics and JSON floating-point round trips need
approximate comparisons, and a failed test currently does not identify which
of several assertions failed. First-class numeric tolerances and source-aware
failure output would shorten the feedback loop considerably.

### Clarify identifier collisions across generated syntax

Two integration failures had almost no useful source location. Reusing
`Loaded` and `Failed` as variants across several result enums caused the enum
macro's generated names to collide only when the API module was imported by the
larger client. In the view, a `NumberField` prop named `value` shadowed VX's
generated JSX `value` attribute function, producing only “cannot call a
non-function value” at an unknown location. Namespacing generated enum variants
and JSX attribute helpers hygienically—or at least reporting both colliding
bindings—would make large applications much safer to assemble.

The server surfaced a related parser failure: a line-broken chain of
`not condition and not condition` checks reported only “call expression missing
callee” against the first line of the file. Rewriting the classifier as small
early-return checks fixed it. Preserving the parser's candidate interpretation
in the diagnostic would turn a long isolation exercise into a local edit.

### Make package boundaries easier to stage

The first layout used nested package facades for `shared`, `simulation`,
`client`, and `server`. Moving types across those boundaries exposed subtle
differences between package visibility, module visibility, enum macro exports,
and operator imports. Top-level facade modules ultimately provided the intended
architecture with less ceremony. Better diagnostics for an inaccessible type,
and a documented pattern for growing a folder of modules into a package, would
make incremental application architecture less trial-and-error.

### Smooth effect names and test captures

Filesystem wrapper functions and their underlying effect operations share names,
which required import aliases to make some server calls unambiguous. Random byte
generation had a similar wrapper/effect ambiguity, so the repository builds its
128-bit IDs from sixteen normalized random integers. Qualified effect-operation
syntax that never competes with ordinary functions would remove that friction.

The REST tests also exposed a steep borrow-rule corner: returning a mutable mock
host's stored `MsgPack` through an effect continuation was rejected as escaping a
borrow. The final host keeps read payloads immutable and uses `SharedCell` only
for write/rename observations. The rule is sound, but an effect-test cookbook
and diagnostics that suggest an owned copy or shared cell would help application
authors reach the right pattern sooner.

### Catch SSR-unstable form properties before runtime

The first real page request found something the server and client compilers did
not: VX's convenient `value(...)` helper represents a DOM property, and an
`option` value has no supported property-to-HTML mapping in the SSR renderer.
The scenario picker now emits an explicit typed `value` attribute, which is the
correct stable form. Tag-aware JSX checking, or an SSR validation pass during
compilation, should report this before a server accepts its first request.

### Make constructor and multiline diagnostics more direct

`val` types are initialized through their `init` API (`Vec2::init(...)`), which
was not obvious when coming from record construction and initially led to using
`Vec2(...)`. Separately, a line-broken arithmetic expression produced a
misleading “expression is not callable” diagnostic because the next line looked
like a call. Diagnostics that suggest the intended constructor or point at the
line-break parse would make these errors much easier to resolve.

### Add a native Canvas surface to VX's documented core

The reusable command added here is intentionally small—lines, polylines,
circles, ellipses, text, glow, and radial fills—and is already enough for a
convincing scientific toy. Future examples would benefit from documented paths,
transforms, line dashes, compositing, text metrics, and pointer capture. Keeping
those as typed VX operations preserves the valuable rule that application logic
stays in Voyd.

### Reduce effect-handler churn when an effect grows

Adding filesystem operations correctly forced every closed `Fs` handler to
account for them. That exhaustiveness is valuable, but it also meant updating
unrelated test fixtures that only wanted a default error. A concise forwarding
or “unhandled operations use this fallback” syntax could retain safety while
reducing mechanical edits in mock hosts.

## Bottom line

The main surprise was not that the gravity math could be written in Voyd; it was
that the mundane full-stack edges could be kept there too. The completed path is
browser gesture → typed message → simulation and Canvas frame → shared JSON
→ HTTP → validated route → atomic filesystem write, with Voyd owning every
application decision along the way. The remaining roughness is concentrated in
ergonomics around boundaries and diagnostics rather than a missing architectural
capability.
