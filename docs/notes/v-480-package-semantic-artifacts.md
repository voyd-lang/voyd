# Package Semantic Artifacts

Status: V-480 prototype complete; v1 distribution is a no-go

Scope: published, target-independent semantic artifacts for installed Voyd
packages

## Decision

Do not publish or enable the v1 package semantic artifact. The prototype proves
that an exact-compiler, closed dependency snapshot can soundly replace package
parsing and semantic analysis, including when source is unavailable. Its
current private-object-graph representation is too large and too slow to load:
fresh-process artifact builds were 46% to 99% slower than source builds and
used 37 to 71 MiB more peak RSS.

Retain the prototype as evidence and an explicit research API. Any follow-up
must replace the full compiler object graph with a substantially leaner checked
representation and an efficient codec, then pass the same compatibility,
correctness, size, latency, and memory gates. The v1 schema is not a stable
public format.

Do not pursue reusable package codegen in this work. Monomorphization,
`ProgramCodegenView`, optimization, and Wasm emission remain whole-program
operations. A codegen artifact needs its own relocatable boundary and
target/runtime/optimization compatibility contract.

Published semantic artifacts are also separate from disposable compiler query
caches. The persisted borrowing cache remains a private, rebuildable cache and
is not a package distribution format.

## Prototype contract

The codec is implemented in
`packages/compiler/src/modules/package-semantic-artifact.ts`. It uses:

- magic `VOYDPKG1`;
- schema `voyd.package-semantic-artifact`, version `1`;
- encoding `msgpack-reference-graph-v1`;
- compiler semantic ABI
  `voyd.compiler.package-semantics:v480-prototype-1`;
- package-interface schema and version from `PackageSemanticInterface`;
- semantic options `includeTests=false;target=independent`; and
- required features for checked bodies, exported macros, and package
  interfaces.

The payload contains dependency `ModuleNode` state, expanded syntax and public
macro definitions, checked semantic results, and one shared type arena and
effect interner. Restored modules are preloaded into the module graph, and their
semantic results are supplied as previous semantics so only consumer source is
analyzed. Package-root paths are replaced with `$VOYD_ARTIFACT_ROOT:...$`
tokens and rebound at load time; when source is unavailable, diagnostics use a
`voyd-artifact://` location.

An artifact covers one closed, production dependency closure. Every contained
module must be `std` or `pkg`, every dependency edge must terminate inside the
artifact, and no module may reach `src`. The loader restores the closure as one
identity domain. It never combines its type arena, effect interner, or private
semantic IDs with independently analyzed dependency state.

This closure shape is deliberate for the prototype. Current imported typing
and generic-body processing consume compiler-private dependency facts, while
module, type, and effect identities are shared across the compilation. A
single-package payload that leaves dependency identities unresolved would be
unsound with the present compiler contracts.

## Identity and compatibility

Each package instance is identified by the exact tuple
`{ name, version, source, integrity }`:

- `name` is the logical resolver name;
- `version` is the exact resolved version;
- `source` is a stable source locator and revision, never a local path; and
- `integrity` is archive or lockfile integrity already verified by the
  resolver.

The header records the owner and a name-sorted record for every package in the
closure. Each record contains a module source manifest and content hash, a
public-contract hash, and direct dependency public-contract hashes. The
contract graph hash covers the complete sorted set. The loader compares the
header's package identities with resolver-supplied identities, validates the
contract graph, restores the payload, and recomputes its package records before
exposing any semantic state.

The prototype permits exactly one resolved instance per logical package name.
This is enforced when writing and reading because current module IDs use
`pkg:<name>` and cannot distinguish two versions. A graph with two instances
must fail clearly; it must never select one or merge their modules. Supporting
multiple versions requires instance-qualified module, symbol, and package
identities throughout the compiler and is separate work.

The semantic ABI is an exact-compiler compatibility token for the private
payload. It must change whenever a private serialized shape or semantic meaning
changes, even if package semver does not. Artifact schema, encoding,
package-interface version, semantic options, and required features are checked
independently so rejection reasons remain precise.

## Public contract and checked capsule

The artifact has two conceptual layers:

1. The public contract is the package's consumer-facing meaning. The prototype
   hashes each module's `PackageSemanticInterface`, including exports, public
   types and members, effects, borrow summaries, coercions, and implementation
   information already represented by that interface.
2. The checked capsule is compiler-private state needed by today's import,
   generic specialization, diagnostics, and codegen preparation paths. The
   prototype preserves expanded syntax, checked bodies, declarations, typing,
   borrowing, exported macro definitions, and the shared arena/interner as a
   reference graph.

Only the first layer is a candidate for an independently evolving public
semantic ABI. The checked capsule is an exact-compiler bridge and may be
replaced wholesale. Local symbol/type IDs, syntax classes, mutable analysis
stores, and reference-graph tags must not become compatibility promises merely
because the prototype serializes them.

## Source authority and fallback

Workspace source is authoritative. Installed-package artifacts may be used
only after the resolver has selected the exact package instances and verified
their integrity. Any rejected artifact falls back to analysis of the complete
dependency closure from source; partial artifact reuse is forbidden. If source
is unavailable, the compiler must report the package identity and rejection
reason rather than proceeding with stale state.

| Condition                                                                                       | Semantic artifact compatible? | Required result                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Trusted installed package, exact identity and closure                                           | Yes                           | Restore the complete closure and analyze consumer source    |
| Different target, runtime, or optimization level                                                | Yes                           | Reuse semantics; run ordinary whole-program emit            |
| Workspace override                                                                              | No                            | Compile workspace source                                    |
| Tests or companion test overlay enabled                                                         | No in v1                      | Compile source with tests                                   |
| Resolver did not verify the artifact                                                            | No                            | Compile source; report `untrusted` if source is unavailable |
| Version, source locator, integrity, owner, or dependency closure differs                        | No                            | Reject as a package-instance or contract-graph miss         |
| Schema, encoding, semantic ABI, package-interface version, options, or required features differ | No                            | Reject with the specific compatibility reason               |
| Source or public contract changes                                                               | No                            | Publish a new identity/artifact; old bytes must miss        |
| Truncated, corrupt, oversized, or structurally invalid bytes                                    | No                            | Reject before exposing restored state                       |
| More than one instance for one logical name                                                     | Unsupported                   | Fail resolution/validation; never mix instances             |

## Decoder and trust boundary

Artifact hashes detect corruption; they do not establish publisher
authenticity. `loadPackageSemanticArtifact` requires `trusted: true`, so package
discovery must verify registry or lockfile integrity before invoking it.

The uncompressed v1 framing and decoder enforce these prototype limits:

- 192 MiB total artifact, 1 MiB header, and 191 MiB payload;
- 500,000 reference-graph nodes and 500,000 entries per collection;
- compiler-object traversal depth of 512;
- 16 MiB payload strings and binary values; and
- bounded MessagePack arrays, maps, and extension values.

The payload SHA-256 is checked before reference-graph decoding. Validation then
rejects invalid references and tags, malformed syntax IDs, duplicate or
non-canonical module identities, open dependency edges, mismatched semantic
module IDs, inconsistent package ownership, a non-shared arena/interner, and
package-root path traversal. No restored state is returned until the header,
payload, reconstructed semantic state, and recomputed contract records agree.
These ceilings are rejection boundaries, not acceptable production sizing
targets; measurement should justify lowering them.

## Evidence and required measurements

V-448 is historical evidence only. At compiler/artifact revision `d139047f` on
2 August 2026, its seven-sample fresh-process benchmark compiled the
representative std fixture with byte-identical Wasm in source and snapshot
modes:

| Historical V-448 result |      Source |    Snapshot |                  Delta | Snapshot load |
| ----------------------- | ----------: | ----------: | ---------------------: | ------------: |
| No optimization         | 2,097.13 ms |   697.78 ms | -1,399.36 ms (-66.73%) |     282.48 ms |
| Release                 | 2,513.49 ms | 1,101.20 ms | -1,412.29 ms (-56.19%) |     283.96 ms |

The V-448 hybrid artifact was 5,239,953 bytes. Its lower-quartile peak-RSS
comparison regressed by 55.52 MiB, and a hosted confirmation measured a 63.90
MiB increase. That feature was removed in commit `1488284d` after demonstrating
that a full private object graph could recover latency while imposing material
memory, migration, and source-path costs. The figures do not measure the V-480
format and must not be used as its result.

V-480 was measured on 7 August 2026 with Node 24.18.0 on an Apple M4 Pro
(14 logical CPUs, 48 GiB RAM). The checked-in benchmark runs seven alternating
samples per mode, one fresh process per compile, after generating the artifact
twice in independent processes. Artifact dependency roots point at nonexistent
directories, so a hit cannot silently read source.

The std scenario uses `vtrace-compute-benchmark.voyd`; the non-std scenario
uses the publishable `voyd_semver` package. Both run in `none` and `release`
optimization modes.

| Current V-480 result                    |            Std / none |         Std / release |  `voyd_semver` / none | `voyd_semver` / release |
| --------------------------------------- | --------------------: | --------------------: | --------------------: | ----------------------: |
| Source compile median                   |           2,138.70 ms |           3,800.11 ms |           1,819.82 ms |             2,384.69 ms |
| Artifact-hit compile median             |           3,900.71 ms |           5,561.25 ms |           3,626.79 ms |             4,147.66 ms |
| Artifact delta                          | +1,762.01 ms (+82.4%) | +1,761.13 ms (+46.3%) | +1,806.97 ms (+99.3%) |   +1,762.96 ms (+73.9%) |
| Artifact read median                    |               3.34 ms |               3.32 ms |               3.36 ms |                 3.31 ms |
| Verify + decode + materialize median    |           3,098.68 ms |           3,158.97 ms |           3,206.73 ms |             3,195.90 ms |
| Artifact bytes                          |            33,638,221 |            33,638,221 |            33,618,855 |              33,618,855 |
| Peak RSS delta                          |            +70.98 MiB |            +56.81 MiB |            +57.64 MiB |              +36.56 MiB |
| Retained-heap growth delta              |            +13.21 MiB |            +14.95 MiB |             +7.47 MiB |               +9.40 MiB |
| Dependency modules read/analyzed on hit |                 0 / 0 |                 0 / 0 |                 0 / 0 |                   0 / 0 |
| Consumer modules recomputed on hit      |                     1 |                     1 |                     1 |                       1 |
| Runtime result parity                   |                   Yes |                   Yes |                   Yes |                     Yes |
| Byte-identical Wasm                     |                    No |                    No |                    No |                      No |

The artifact bytes were identical across the two fresh producer processes in
both scenarios. The std hit reused 49 modules. The `voyd_semver` hit reused 48
std and four package modules. Perf counters recorded no dependency reads,
parsing, or semantic recomputation on any hit, which validates the intended
boundary.

The load cost dominates. Across the four rows, header validation took about
7.4-7.7 ms, payload SHA-256 verification 550-570 ms, reference-graph decoding
2,354-2,456 ms, semantic materialization 24-34 ms, and reconstructed contract
verification 147-154 ms. Reading 33.6 MB from the filesystem took only about
3.3 ms.

Generated Wasm validated and produced the same runtime results, but source and
artifact builds did not have identical hashes. The release binaries had equal
byte lengths while still differing in content. The focused SDK test also
checks diagnostic code, message, and span parity for a package-dependent type
error. Binary reproducibility remains an additional requirement for any
follow-up format.

The benchmark is reproducible with:

```sh
npm run --workspace @voyd-lang/performance-tests bench:package-artifact
```

Focused invalidation tests cover package and transitive std identity changes,
untrusted artifacts, workspace overrides, test overlays, corruption, and
source-unavailable fallback diagnostics. The header validator separately
checks schema, compiler semantic ABI, package-interface version, options, and
required features before exposing state.

## Recommendation and follow-up

The v1 semantic artifact is a **no-go** for distribution. It meets the
correctness, compatibility, determinism, and source-bypass goals, but fails the
latency, size, memory, and binary-reproducibility gates. The historical V-448
result shows that semantic reuse can be fast; the contrast identifies the full
reference graph and its generic JavaScript hashing/decoding path as unsuitable
distribution machinery.

Reusable package codegen is a **no-go** for this design. Reconsider it only if
semantic-hit profiles show that dependency-attributable monomorphization,
`ProgramCodegenView` construction, optimization, and codegen still dominate.
That follow-up must define relocatable units, stable symbol/type relocation,
consumer ownership of generic specializations, target/runtime/codegen ABI keys,
and an explicit whole-program/LTO fallback before implementing a cache.

Narrow follow-up work, if package-artifact work resumes, is:

1. Design a compact checked dependency IR rather than serializing compiler
   classes, expanded syntax, and mutable stores directly.
2. Use a native or streaming integrity/codec path and set a size/load budget
   before implementation; the v1 33.6 MB and 3.1-3.2 s load are the baseline
   to beat.
3. Make artifact and source builds assign reproducible program identities so
   equivalent inputs produce byte-identical Wasm.
4. Add resolver-owned discovery with exact identity and integrity verification
   only after a replacement representation clears the performance gate.
5. Version the public semantic contract independently from the exact-compiler
   checked capsule as current import boundaries permit.
6. Open a separate codegen-artifact architecture decision only if residual
   profiles justify it.
