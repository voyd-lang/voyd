# External Package Adapter Boundary

Status: implemented fallback ABI

## Contract

`@external(id: "...")` declares either a synchronous function or an effectful
asynchronous interface implemented by a host-language package adapter. The Voyd
declaration, interface ID, function name, execution kind, and boundary-compatible
parameter/result shapes are the stable contract.

Generated contracts expand those shapes into a transport-neutral structural
DTO schema and fingerprint the complete set of functions in each versioned
interface. Compiler-local reference IDs never cross into the package contract.

The core-Wasm fallback records only reachable function requirements. It
validates those shapes, validates a provider's complete fingerprint against its
own immutable contract, and forbids splitting one interface across providers;
it cannot independently reconstruct an unused declaration's shape. The
versioned interface ID is therefore the nominal compatibility promise in the
fallback. Component Model linking later enforces the generated WIT interface as
a whole without changing package or adapter source.

The compiler lowers reachable calls to imports in the `voyd.external` core-Wasm
module and records normalized requirements in `voyd.external_requirements`.
Synchronous arguments and results currently use the existing boundary schema plus MsgPack
transport. Transport pointers, buffer sizing, compiler type IDs, and MsgPack
are not public package API.

External effects lower through the normal Voyd effect runtime. The requirements
section records their operation ID, signature hash, resume kind, and DTO schema;
the host registers adapter functions as typed effect handlers.

`@voyd-lang/package-adapter` owns the host-language descriptor and
`defineVoydPackageAdapter`. It deliberately has no compiler, SDK, JS-host, or VX
dependency. `@voyd-lang/js-host` validates requirements and supplies the import
trampolines during instantiation. Node discovery and build-time registry
generation live in the SDK and CLI respectively.

## Boundary rules

- Adapter descriptors contain sync and async functions and, in a future revision, resources.
- UI frameworks are consumers of functions, not adapter categories.
- Recoverable errors belong in explicit Voyd result types. A thrown host error
  is a runtime failure annotated with external function identity.
- A synchronous external function returning a Promise is an error; an async
  external effect may return either a value or Promise.
- The host invokes functions with a host-owned `this` context. It reserves
  optional cancellation and resource-table capabilities so they can be wired
  without changing generated function signatures.
- External schemas must stay within the Component Model-compatible DTO subset.
- Recursive value graphs are rejected; callers must use explicit indexed DTOs
  or future resource handles.
- Installed packages are not loaded merely because they exist; only reachable
  interface requirements select providers.

## Component Model migration

The Component Model backend replaces core imports and MsgPack lowering with
component imports and Canonical ABI lowering. Generated WIT already describes
the stable `namespace:package/interface@version` identity and supported DTO
subset. Voyd package APIs and generated adapter
implementation shapes remain stable; packages may require rebuilding.

The Component Model host keeps a generated adapter-value façade between
canonical bindings and package implementations. It normalizes i64 and variant
payload representations, so WIT binding conventions do not leak into the
transport-neutral JavaScript adapter API.

Resources should extend the same interface model. External integrations must
not be implemented as special VX hooks or arbitrary JavaScript object escape
hatches.
