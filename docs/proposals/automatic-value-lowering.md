# Automatic Value Lowering

Status: Proposed
Owner: Compiler Architecture Working Group
Scope: optimizer analyses, optimized IR, codegen lowering decisions

## Goal

Add an optimization path that keeps source-level `obj` types and APIs unchanged while
automatically lowering eligible heap-object values into value-like storage when the
compiler can prove identity is not observable.

This should let users keep ergonomic `obj` code in straightforward cases while still
getting some of the runtime benefits that explicit `value` declarations provide today.

## Motivation

Voyd now has explicit `value` declarations for types that are intentionally fixed-layout
and copy-oriented. That covers the deliberate, source-visible performance path.

There is still a large class of code that looks like this:

```voyd
obj Pair {
  left: i32,
  right: i32
}

fn sum() -> i32
  let pair = Pair { left: 3, right: 4 }
  pair.left + pair.right
```

Semantically this is an identity-bearing heap object. Operationally, in many cases it is
just a short-lived aggregate whose allocation and field loads could be eliminated.

Explicit `value` should remain the strongest and most predictable way to request
value-style lowering. But the optimizer should also recover obvious non-escaping heap
allocations where identity is never observed.

## Non-goals

- Reinterpreting `obj` declarations as `value` declarations in the type arena.
- Changing source-level typing, compatibility, or API surface.
- Making every heap object eligible for stack or scalar lowering.
- Replacing explicit `value`; this proposal is a complement, not a substitute.
- Solving trait-object lowering, dynamic identity, and recursive heap structures in the
  first pass.

## Principle

Keep semantic types unchanged.

The optimizer should not rewrite `nominal-object` into `value-object`. Instead it should
attach lowering facts to specific object allocations and object-typed locals when those
values are proven to be:

- exact in nominal type
- non-escaping
- never observed through identity-sensitive operations
- only used through a restricted set of reads, writes, and direct calls

In other words:

- semantics remain heap/object semantics
- optimized lowering may use value-like storage for particular instances

## First Pass

The first implementation should target a narrow, high-confidence case:

- object literals of exact nominal `obj` types
- allocated and consumed within a single function instance
- not returned across an ABI boundary
- not stored into heap containers, globals, closure environments, or trait objects
- not passed to unknown/effectful/dynamic callees
- not merged across control flow with values of different exact shapes

Eligible examples:

```voyd
obj Pair {
  left: i32,
  right: i32
}

fn add_pair() -> i32
  let pair = Pair { left: 3, right: 4 }
  pair.left + pair.right
```

Initially ineligible examples:

- values captured by lambdas
- values stored into arrays or object fields
- values widened to trait objects
- recursive objects
- values returned from public/exported boundaries
- values passed to calls without exact-target knowledge

## Required Analyses

### Escape analysis

Track whether an allocation escapes the current function instance through:

- return
- assignment into heap fields
- insertion into arrays or other containers
- capture into closures/effect handlers
- trait-object conversion
- opaque function calls

If any escape exists, the allocation is not eligible in the first pass.

### Exact nominal analysis

Reuse and extend exact-target / exact-constructor facts so the optimizer knows the exact
nominal object type at each allocation and use site.

### Identity-sensitive use analysis

Treat these as blocking in the first pass:

- any operation that could observe identity or aliasing
- dynamic dispatch requiring heap/reference form
- unknown method or field accessor paths

The conservative rule should be: if we are not sure identity is irrelevant, keep the heap
allocation.

## Transformation Model

Do not mutate the type arena.

Instead, introduce optimized IR facts for specific object values:

- allocation site id
- exact nominal type id
- replacement field storage plan
- whether the value can be represented as:
  - per-field locals
  - a small aggregate temporary
  - an existing inline value layout if the field set is compatible

For the first pass, per-field locals are sufficient.

Example transformation conceptually:

```voyd
let pair = Pair { left: 3, right: 4 }
pair.left + pair.right
```

becomes optimized IR equivalent to:

```voyd
let pair_left = 3
let pair_right = 4
pair_left + pair_right
```

Mutations update those locals directly.

## Codegen Strategy

Codegen should consume optimization facts rather than rediscover them.

For an allocation marked as scalar-replaceable:

- do not materialize the heap object
- emit locals/temps for the object fields
- rewrite field reads to local reads
- rewrite field writes to local writes

If a later use requires heap form after all, codegen may materialize the object at the
boundary as a fallback, but the first pass should prefer simply refusing optimization when
such a boundary exists.

## Interaction with Explicit `value`

Explicit `value` remains:

- the user-controlled layout contract
- the preferred representation for hot-path fixed-layout data
- the type-level signal used by arrays, unions, and signature lowering

Automatic value lowering is different:

- it is opportunistic
- it applies to specific object instances, not object declarations
- it must preserve `obj` semantics exactly
- it may disappear if code structure changes

That distinction should stay clear in docs and diagnostics.

## Diagnostics

No user-facing diagnostics are required for the first pass.

This should behave as a transparent optimization, not a source feature. Debug tooling may
later expose optimization remarks such as:

- allocation elided
- scalar replacement applied
- optimization blocked by escape to closure/container/trait-object boundary

But remarks are follow-up work, not MVP.

## Pipeline Placement

Run this after semantic/codegen view construction and before Wasm codegen, alongside the
existing optimization pipeline.

It should integrate with:

- constructor-known simplification
- exact-target facts
- closure/environment shrinking

The intended order is:

1. collect exact constructor facts
2. compute escape facts
3. mark scalar-replaceable object allocations
4. emit optimized bodies with value-like lowering

## Open Questions

- Should the first pass support intra-function returns when caller and callee can both stay
  in optimized IR form?
- Should we materialize heap form lazily at the first escaping boundary, or require
  all-or-nothing non-escape in the MVP?
- Can we reuse parts of `value-object` inline layout machinery for optimized `obj`
  instances without conflating the two semantic categories?
- When should tuples and structural objects participate in the same optimization family?
- How should optimization remarks be surfaced without making performance behavior feel
  unstable or noisy?
