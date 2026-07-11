---
order: 18
---

# External packages

Voyd packages can expose functions implemented by JavaScript or another host
language. The public API remains ordinary typed Voyd code; a package adapter
provides the external implementation when the Wasm module is instantiated.

External package support is independent of VX. A renderer, parser, database
client, or cryptography library uses the same function boundary.

## Installing and using a package

Install a mixed Voyd/JavaScript package through npm:

```bash
npm install @voyd-lang/markdown
```

Voyd resolves its source through the normal `pkg::` namespace:

```voyd
use pkg::markdown::{ StaticHtml, to_static }

pub fn main() -> StaticHtml
  to_static("# Hello")
```

The Node CLI discovers installed adapters automatically when running source:

```bash
voyd --run ./src/main.voyd
```

Browser builds use a generated static registry so bundlers can see the required
JavaScript imports:

```bash
voyd generate registry ./src/main.voyd \
  --out ./src/generated/voyd-adapters.ts
```

```ts
import { adapters } from "./generated/voyd-adapters.js";

const host = await createVoydHost({ wasm, adapters });
```

The VX starter performs this generation automatically.

## Declaring an external function

`@external` marks either a synchronous function or an asynchronous effect whose
implementation is supplied by an adapter:

```voyd
use std::string::type::String

@external(id: "example:markdown/renderer@1")
pub fn render_html(source: String) -> String
```

External functions are bodyless declarations and must have explicit parameter
and result types. Labeled arguments are supported; default parameters are
rejected in the fallback ABI so adapters always receive a fixed argument list.

The ID is a stable interface identity, not an npm package name. Use the WIT-shaped
`namespace:package/interface@version` form and change its major version for an
incompatible contract.

External values are restricted to boundary-compatible values:

- booleans and numeric primitives;
- strings;
- arrays;
- public records and structural records;
- options, results, and named variants.

DTO graphs must be acyclic because Component Model values cannot be recursive.
Represent trees and graphs with flat node arrays plus integer indices, or use a
future resource/handle interface when identity is required.

Closures, DOM nodes, arbitrary JavaScript objects, cyclic graphs, and values
whose meaning depends on JavaScript object identity cannot cross this boundary.

External functions are synchronous in the current fallback ABI. Returning a
Promise from one is a runtime error. Use an external effect when the host may
suspend:

```voyd
@external(id: "example:data/client@1")
pub eff DataClient
  load(tail, url: String) -> String
```

External effects use Voyd's existing effect runtime, so their suspension and
effect requirements remain visible in Voyd types. The generated adapter accepts
either a result or `Promise<result>` for these operations.

## Generating adapter bindings

Re-export external functions from the package root, then run:

```bash
voyd generate adapter ./src --out ./generated
```

The generator compiles the canonical `pkg.voyd` package graph once (falling
back to individual external declaration files for legacy source folders) and
produces:

- `contract.json`: portable interface metadata;
- `contract.ts`: the runtime contract;
- `voyd-adapter.ts`: a typed package-specific `defineAdapter` helper;
- `interface.wit`: the corresponding Component Model package and interface,
  including records, lists, optional fields, variants, and shared acyclic references.
  If one adapter spans multiple WIT packages, additional `interface-*.wit`
  documents are emitted.

The generated contract expands compiler references into structural DTO schemas
and strips compiler-local type IDs. It also records a deterministic fingerprint
of every function in each versioned interface.

## Implementing the adapter

Package authors implement the generated interface:

```ts
import { defineAdapter } from "../generated/voyd-adapter.js";

export default defineAdapter({
  "example:markdown/renderer@1": {
    render_html(source) {
      return renderMarkdown(source);
    },
  },
});
```

`defineAdapter` delegates to the lower-level
`defineVoydPackageAdapter(contract, implementation)` API. The generated helper
is preferred because it fixes the correct IDs, functions, and TypeScript types.

Generated functions receive a typed host invocation context as their
JavaScript `this` value. The fallback host currently supplies an empty context;
`signal` and `resources` are reserved optional capabilities for a later runtime
revision and must be feature-detected before use. Arrow functions remain valid
when the context is not needed. These capabilities are framework agnostic and
do not introduce a VX dependency.

`defineVoydPackageAdapter` validates that every required function is present,
unknown functions are rejected, and the adapter ABI is supported. It only
creates an immutable descriptor; it does not inspect packages, instantiate
Wasm, or register global state.

## Package metadata

The npm package advertises its source, adapter entrypoints, and provided
interfaces:

```json
{
  "name": "@example/markdown",
  "voyd": {
    "source": "./src/pkg.voyd",
    "adapter": {
      "abi": 1,
      "interfaces": ["example:markdown/renderer@1"],
      "browser": "./adapter",
      "node": "./adapter",
      "default": "./adapter"
    }
  }
}
```

Only adapters required by reachable external functions are loaded. Missing,
duplicate, and structurally incompatible providers fail before the external
function executes.

The fallback linker checks every reachable function and requires one provider
per versioned interface. Its whole-interface fingerprint proves that the
adapter descriptor is internally complete and unmodified; because core-Wasm
requirements intentionally omit unreachable declarations, the versioned
interface ID remains the nominal promise for those unused members. Component
Model linking replaces that limitation with whole-WIT-interface validation.

## Runtime API

Custom embedders can pass adapters explicitly:

```ts
import markdownAdapter from "@voyd-lang/markdown/adapter";

const host = await createVoydHost({
  wasm,
  adapters: [markdownAdapter],
});
```

The fallback synchronous transport uses the host `bufferSize` for each encoded
argument/result payload. If a payload is larger, the host throws an actionable
capacity error without invoking the adapter twice. Increase `bufferSize` for
applications that intentionally exchange large DTOs; this limit disappears
when the transport is replaced by the Component Model canonical ABI.

Node applications can discover them using the SDK:

```ts
const adapters = await loadVoydPackageAdapters({
  wasm,
  startDir: process.cwd(),
});
```

On Node, `compileResult.run(...)` performs this discovery automatically when
the caller does not supply `adapters`. Passing an explicit adapter list disables
discovery for that run. Browser builds use the generated static registry.

The compiler records reachable imports in the versioned
`voyd.external_requirements` custom section. MsgPack is used by the current
fallback transport but is not part of the package contract.

## Component Model migration

The durable contract consists of the Voyd API, external interface ID, function
names, execution semantics, and DTO shapes. The current MsgPack buffer,
core-Wasm import trampolines, custom section, and generated JavaScript registry
are replaceable transport details.

When Voyd adopts the Component Model, synchronous functions become component
imports and async effect operations map to async component calls as that support
lands. Generated WIT becomes the linking interface. Packages may need to be
rebuilt, but conforming Voyd application source and adapter implementation
source should not need to change.

Canonical Component Model bindings are not themselves the JavaScript adapter
API: the future host backend owns a generated façade that converts canonical
values to the stable adapter DTO representation. In particular it normalizes
64-bit integers accepted as JavaScript numbers or bigints and maps WIT variant
payload records to the existing flat `{ tag, ...fields }` objects. This shim is
what preserves adapter implementation source across the transport migration.
