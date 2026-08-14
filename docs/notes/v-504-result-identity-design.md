# V-504 Result Identity Design

Status: Implemented

Decision date: 2026-08-13

## Decision

Callable result identity is a separate, finite contract from the ordinary
direct/reachable access summary. A callable has one of four dispositions:

| Result disposition | Meaning |
| --- | --- |
| Conservative | The result may carry mutable identity from any reference-bearing input. This is the default and the fallback for missing package metadata. |
| Detached | The result carries no mutable identity from an input. It may retain compiler-known immutable backing, such as `StringSlice`. |
| Fresh outer | The outer mutable identity is new. Its children may still carry input identity and remain alias-sensitive. |
| Same place | The result is the exact exclusive receiver or parameter named by the contract. The one capability is forwarded through an immediate expression. |

`@result(detached)` and `@result(fresh)` are checked library-author
contracts. Same-place forwarding uses receiver/parameter-refined return syntax:

```voyd
fn set(~self, key: K, value: V) -> ~self
  // ...
  self
```

Ordinary application code does not need annotations for direct local
construction, stable `StringSlice` results, or fresh values whose type already
proves disjointness.

The package semantic interface stores at most one enum and one parameter index
per callable. There are no result paths, regions, implementation sets, or
result fixed points. Callers never inspect callee bodies for acceptance.

## V-505 investigation matrix

| Case | V-509 baseline | Disposition |
| --- | --- | --- |
| Stable parser token retained while cursor advances | Direct `StringSlice` works; aggregate parser results remain conservative | Existing stable handle or Detached |
| JSON parsing without source stabilization | Direct slice behavior works | Existing stable handle; Detached for owned aggregate results |
| Fresh local builders with repeated mutation | Works | API ownership; no new contract |
| Shallow copy, then mutate the independent copy | Imported/same-type helpers reject with `TY0048` or `TY0055` | Fresh outer |
| Independently mutable helper result across a package | Different nominal result types work; same-type results reject | Fresh outer, serialized |
| Fluent `Dict.set(...).set(...)` | `-> ~self` parses but was not a valid result type | Same place |
| `Dict.entries()` snapshot | Eager snapshot consumed before later mutation works | Fresh outer; retained children stay conservative |
| Dict-specific snapshot followed by insertion | Safe when the snapshot is complete before mutation | Checked staging/API ownership |
| Arbitrary `Sequence` iteration during mutation | Dynamic iterator may retain, re-enter, callback, or suspend | Intentionally conservative |
| Returned mutable child | Existing local alias flow rejects later conflicting access | Conservative negative control |
| Mutable Dict/Set wrappers | Missing APIs or duplicated/persistent implementations | Parameter forwarding/API cleanup |
| Bulk byte/string append | Generic source and destination may truly overlap | Checked staging, separate from result identity |
| HTTP request buffering | Scalar loop despite an existing bulk path | Conservative host chunk; Detached aggregate plus bulk append |
| JSON/MessagePack output | One node and one `SharedCell` check per byte | Scoped contiguous builder ownership |
| OpenAPI component accumulation | Persistent maps and transport-only result carriers | Ordinary fresh accumulators plus staged collection updates |

## Same-place rules

A same-place result is an ephemeral capability, not an ordinary alias. The
initial surface permits immediate chaining through another matching same-place
receiver or parameter. The final result must be ignored. It cannot be bound,
stored in an aggregate, duplicated, captured, suspended, converted to a plain
value, or returned from a callable without a matching same-place contract.

Every successful return in the callee must name the declared mutable parameter
or forward a matching same-place result for that parameter. Returning a new
value or another parameter is rejected. Evaluation between chain links must not
introduce an overlapping access, reentrant callback, effect, or suspension.

Binding a result as a move was considered:

```voyd
let ~next = dict.set("x", 1)
```

It would require callable-local move state that makes the old binding
unavailable on every CFG path. Immediate expression forwarding covers fluent
builders with much less source and compiler surface, so binding is deferred.

## Soundness boundaries

- Detached concerns mutable identity, not byte ownership or lifetime. Only
  compiler-known immutable retained backing may cross the contract.
- Fresh outer does not detach children. A returned `Array<(K, V)>` may own its
  array spine while `K` and `V` still alias the source graph.
- Fresh declarations must prove that mutable child identity comes from an
  explicit input or another checked construction. Ambient, effect-derived,
  reentrant, and suspended sources are rejected.
- Generic callbacks whose results can carry references do not satisfy that
  proof. For example, `Dict.map` and conflict-resolving `Dict.merged` keep
  conservative result identity, while `filter` and input-derived snapshots can
  declare FreshOuter.
- Unequal roots never prove reachable object graphs disjoint.
- Dynamic/open calls retain their conservative ambient, reentrant, suspension,
  and effect behavior.
- Missing, stale, or unsupported package metadata selects Conservative.
- Overlap-safe staging and scoped builder ownership are separate checked
  decisions. They are not encoded as result identity.

`RequestBody.next` deliberately remains Conservative. Its streamed chunk can
come from a resumable host effect, and this design does not add result-identity
syntax to effect operations or assume host results are detached. The buffered
branch also crosses the generic `SharedCell.with_mut` callback boundary.
`RequestBody.read_all` consumes every chunk into its own buffer through the
staged bulk path and publishes a checked Detached aggregate. This restores the
bulk append without adding an extra per-chunk copy.

## Staged overlap and builders

The V-505 matrix also found one irreducible parameter relationship. A bulk
append or collection update may intentionally accept a source that aliases its
mutable destination after it has captured everything it will read. Library
authors declare that finite relationship with one destination index:

```voyd
@staged(into: self)
fn extend(~self, other: Array<T>) -> void
```

The compiler checks that every other reference-bearing input is read before the
first destination write on every CFG path. A thin wrapper may forward to one
exact compatible staged call. Ambient access, callbacks, effects, suspension,
open dispatch, ambiguous targets, and source reads after a destination write
remain conservative. Package metadata stores only the destination parameter
index; it is separate from both ResultIdentity and OrdinaryMutationSummary.

The contiguous MessagePack encoder exposed a second irreducible relationship.
Recursive streaming writes must interleave reads from an input graph with
writes to a private output builder, so the read-before-write rule of `@staged`
does not apply. Library authors can declare this relationship with one
destination index:

```voyd
@builder(into: writer)
fn write_value(~writer: Writer, value: Value) -> Result<Unit, Error>
```

At a call, the destination must be a locally created, unique fresh builder and
the selected target must be exact and closed. The source cannot be derived from
that builder. The declaration checker rejects effects, re-entry, suspension,
capture, return, or retention of a reference-bearing source in the destination;
recursive and thin forwarding calls must carry the same checked builder
contract. Missing, open, ambiguous, and non-fresh cases remain conservative.

This contract is deliberately separate from staging: staging proves an order,
while builder ownership proves non-retention into one private destination.
Like staging, package metadata stores one destination parameter index. JSON and
MessagePack both require `@builder` for recursive streaming because reads from
the input graph interleave with writes to the output. OpenAPI uses ordinary
fresh accumulators and staged collection operations instead.

## Alternatives

### General result provenance

Rejected because field/projection origins and a call-graph result fixed point
recreate the unbounded architecture removed by V-500. They also make package
contracts and compile time depend on aggregate shape and call topology.

### Optimizer or exact-body facts

Rejected for source acceptance. Safety cannot depend on whether a body is
available, which optimization mode is enabled, or which implementation was
selected after typing.

### Wrapper types such as `Detached<T>` or `Fresh<T>`

Rejected because they would leak ownership plumbing into ordinary application
types, overloads, pattern matching, and public APIs. Result identity is a
callable relationship rather than a new runtime value.

### Persistent updates and universal builder closures

Persistent updates preserve safety but impose repeated collection copying.
Builder closures are useful for some private construction scopes, but they do
not address parser results or fluent methods and add callback-shaped APIs.

### Treating builders as staged operations

Rejected because a recursive encoder reads source data after earlier output
writes by design. Weakening the staging rule would accept true overlap without
a snapshot. The distinct builder contract keeps both checks small and gives
each one a precise proof obligation.

## Complexity and runtime cost

- Conservative calls keep the existing cheap path.
- Detached and FreshOuter require one selected-contract branch and bounded
  caller-local alias work only when the result is retained.
- Same-place chains carry one place through each link, so work is linear in
  chain length and independent of projection depth.
- The contracts add no runtime checks or copies.
- Same-place returns the existing handle and performs no allocation.
- Staged bulk operations remain linear. APIs that promise self-overlap may
  snapshot unconditionally when there is no cheap runtime disjointness test.
  `Dict.extend` now takes one entries snapshot, applies it to one fresh copy of
  the destination, and publishes that copy through an exact staged helper that
  snapshots both replacement fields before either destination write. This
  costs O(n + m) time and temporary storage for destination size `n` and source
  size `m`, while avoiding a whole-dictionary copy for each inserted entry.
- Staged validation carries one forward dataflow bit per CFG block and one
  destination parameter index per declared callable.
- Builder validation carries one finite parameter-origin set while checking a
  declaration and one destination parameter index in exported metadata. Caller
  eligibility is constant-size and does not traverse the call graph.

Performance validation uses independent generated workloads for result count,
fluent-chain length, projection depth, generic forwarding depth, overload
fanout, and unrelated call-graph size. Missing result contracts must not
allocate result-alias state in ordinary no-result code.
