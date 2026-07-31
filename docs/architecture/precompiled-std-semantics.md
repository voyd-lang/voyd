# Precompiled standard-library semantics

Voyd ships a compiler-owned semantic snapshot for the standard-library modules
reachable from the default prelude. A fresh Node SDK or CLI process restores
that snapshot before loading the application, so it does not parse, bind, type,
or borrow-check those unchanged std bodies.

The source-analysis path remains authoritative. The compiler falls back to it
whenever the artifact is absent or fails validation.

## Compatibility and invalidation

The artifact header includes:

- the precompiled-std schema and version;
- the compiler's explicit precompiled-std compatibility ABI;
- the canonical reference-graph/Brotli transport identity and optional
  Node/V8 accelerator schema;
- the callable-borrow-summary schema and version;
- the complete non-test std source manifest and aggregate SHA-256;
- the semantic options identity (`includeTests=false`, std dependency scope);
- independent SHA-256 hashes for the canonical payload, its compressed
  transport bytes, and the V8 accelerator, plus the accelerator's Node and V8
  producer versions.

The loader rejects incompatible, stale, truncated, corrupt, or partial
artifacts before exposing semantic facts. It verifies the current std file set
as well as every recorded file hash, so adding, removing, or changing a source
file invalidates the snapshot. Test-enabled std builds use source analysis.
The uncompressed reference graph has a canonical, engine-independent encoding,
so freshness is not coupled to the producer's V8 serialization format or
compressed bytes. The loader verifies both payload transports before attempting
the faster V8 payload, without eagerly decompressing the canonical fallback.
If the accelerator is corrupt or cannot be deserialized by the current engine,
it restores the canonical payload instead; source analysis remains the final
fallback.

Paths in the payload are rooted at `$VOYD_STD_ROOT$` and are rebound to the
installed package location during restoration. Type-arena IDs, effect rows,
module IDs, symbols, trait dispatch metadata, public borrowing summaries,
source locations, and private compiler facts are restored as one identity
domain. A snapshot is never mixed with a separately created arena or interner.

Fallbacks are observable through `snapshotPrecompiledStdLoadStats()` and the
compiler performance counters. Production compilation does not log fallback
noise.

## Generation and freshness

Regenerate after changing the compiler snapshot ABI/schema, callable-summary
schema, or non-test std sources:

```sh
npm run generate:std-snapshot
```

Verify determinism and freshness:

```sh
npm run check:std-snapshot
```

The std test task runs the freshness check. The generated binary lives at
`packages/std/precompiled/std-semantics-v1.bin` and is included in the
published `@voyd-lang/std` package. It is generated from compiler analysis;
there is no manually maintained semantic blob.

The compiler ABI is intentionally independent of the compiler package patch
version, so compatible compiler releases keep using the published std
artifact. A compiler-only release runs the freshness check and is blocked if
its analysis would produce different snapshot content. In that case, bump
`PRECOMPILED_STD_COMPILER_ABI_VERSION`, select std in the release plan, and
regenerate and publish the artifact. Std releases regenerate it automatically.
An ABI mismatch rejects reuse and follows the source fallback.

The checked-in snapshot covers the default prelude graph. If an application
imports another std module, that module follows the ordinary source-analysis
path in the restored arena and effect interner. The full std source manifest
must still match before this extension is allowed, so the compiler never joins
facts from different std revisions.

## Scope and future generalization

This mechanism is intentionally std-specific. It serializes the current
compiler semantic snapshot closely enough to preserve codegen and diagnostics;
it is not the package interface format.

General package contracts should instead expose a smaller, stable
consumer-facing boundary:

- explicit or compiler-emitted public type and borrowing contracts;
- compact trait, effect, and dispatch metadata;
- package-local inference and validation performed once when publishing;
- downstream compilation that never depends on private dependency bodies;
- content-addressed package artifacts with incremental invalidation.

That design can reuse the compatibility and source-manifest principles here
without standardizing this compiler-private payload.
