const fallbackCounters = (
  prefix: string,
  reasons: readonly string[],
): string[] => reasons.map((reason) => `${prefix}.fallback.${reason}`);

const dispositionCounters = (
  prefix: string,
  dispositions: readonly string[],
): string[] => dispositions.map((disposition) => `${prefix}.${disposition}`);

export const STABLE_FIELD_FALLBACK_REASONS = [
  "local-mutation",
  "local-capture",
  "local-retention",
  "local-result-alias",
  "dynamic-dispatch",
  "identity-guard",
  "unresolved-target",
  "exact-fact-unavailable",
  "unsafe-boundary",
  "escape",
  "retention",
  "result-alias",
  "unsupported-argument-plan",
  "whole-value-access",
  "candidate-field-write",
] as const;

export type StableFieldFallbackReason =
  (typeof STABLE_FIELD_FALLBACK_REASONS)[number];

export const MUTABLE_SCALAR_AGGREGATE_LANE_ABI_FALLBACK_REASONS = [
  "missing-body",
  "missing-module-context",
  "unsupported-layout",
  "missing-parameter",
  "missing-signature",
  "effectful",
  "result-abi",
  "parameter-abi",
  "optional-parameter",
  "defaulted-parameter",
  "parameter-type",
  "exact-fact-unavailable",
  "unsafe-boundary",
  "explicit-void-return",
  "whole-value-access",
  "indirect-access",
  "escape",
  "retention",
  "result-alias",
  "no-writes",
  "unknown-field",
] as const;

export type MutableScalarAggregateLaneAbiFallbackReason =
  (typeof MUTABLE_SCALAR_AGGREGATE_LANE_ABI_FALLBACK_REASONS)[number];

export const SCALAR_AGGREGATE_INITIALIZER_DECISIONS = [
  "applied",
  "bailout.effectful",
  "bailout.interior_mutability",
  "bailout.no_layout",
  "bailout.address_taken",
  "bailout.too_wide",
  "bailout.mutable_dynamic_use",
  "bailout.identity_observable",
  "bailout.nested_assignment",
  "bailout.handler_capture",
  "bailout.escape_or_shape",
  "bailout.lowering_fallback",
] as const;

export type ScalarAggregateInitializerDecision =
  (typeof SCALAR_AGGREGATE_INITIALIZER_DECISIONS)[number];

export const SCALAR_AGGREGATE_PARAMETER_DECISIONS = [
  "applied",
  "bailout.effectful",
  "bailout.mutable",
  "bailout.escapes",
  "bailout.no_layout",
  "bailout.incompatible_abi",
  "bailout.too_wide",
  "bailout.lane_mismatch",
] as const;

export type ScalarAggregateParameterDecision =
  (typeof SCALAR_AGGREGATE_PARAMETER_DECISIONS)[number];

export const ARRAY_LOOP_PROOF_FALLBACK_REASONS = [
  "nested-control",
  "control-transfer",
  "array-reassigned",
  "index-update",
  "array-method",
  "dynamic-call",
  "identity-guard",
  "unresolved-call",
  "missing-summary",
  "suspending-call",
  "ambient-access",
  "unknown-callback",
  "parameter-write",
  "array-alias-argument",
  "index-count",
] as const;

export type ArrayLoopProofFallbackReason =
  (typeof ARRAY_LOOP_PROOF_FALLBACK_REASONS)[number];

export const EXACT_ITERATOR_FALLBACK_REASONS = [
  "noncanonical-iter-call",
  "noncanonical-body",
  "nonexact-receiver",
  "unresolved-iter-target",
  "missing-iter-metadata",
  "missing-iter-body",
  "nonfresh-iterator-result",
  "unresolved-next-target",
  "missing-next-trait-mapping",
  "ambiguous-next-implementation",
] as const;

export type ExactIteratorFallbackReason =
  (typeof EXACT_ITERATOR_FALLBACK_REASONS)[number];

export const ORDINARY_IDENTITY_GUARD_REJECTION_REASONS = [
  "same-place-overlap",
  "incomplete-identity",
  "proven-overlap",
  "suspending-target",
  "ambient-access",
  "unknown-callback",
  "unresolved-target",
  "unguardable-default",
  "missing-expression",
] as const;

export type OrdinaryIdentityGuardRejectionReason =
  (typeof ORDINARY_IDENTITY_GUARD_REJECTION_REASONS)[number];

export const DEFAULT_IDENTITY_GUARD_COMPANION_FALLBACK_REASONS = [
  "missing-protocol",
  "missing-body",
] as const;

export type DefaultIdentityGuardCompanionFallbackReason =
  (typeof DEFAULT_IDENTITY_GUARD_COMPANION_FALLBACK_REASONS)[number];

const stableFieldPrefix = "optimize.pass.stable-field-load-forwarding";
const mutableLanePrefix = "codegen.mutable_scalar_aggregate_lane_abi";
const scalarInitializerPrefix = "codegen.scalar_aggregate.initializer";
const scalarParameterPrefix = "codegen.scalar_aggregate.parameter";
const safeArrayWhilePrefix = "codegen.safe_array_while";
const rangeArrayScopePrefix = "codegen.range_array_safe_scope";
const intrinsicArrayPrefix = "codegen.intrinsic_array_for";
const intrinsicRangePrefix = "codegen.intrinsic_range_for";
const exactIteratorPrefix = "codegen.exact_iterator_for";
const identityGuardPrefix = "borrowing.identity_guard";
const defaultGuardCompanionPrefix = "codegen.default_identity_guard_companion";

/**
 * Counters whose presence is part of the V-500 performance-report contract.
 * Register each name with zero at session start so absence never masquerades
 * as a zero decision count.
 */
export const COMPILER_PERF_ZERO_PRESENCE_COUNTERS: readonly string[] = [
  "borrowing.ordinary.strictAscents",
  "borrowing.ordinary.dependencyEnqueues",
  "borrowing.ordinary.solverBound",
  "borrowing.ordinary.solverBoundUsage",
  "borrowing.ordinary.liveness.cfgBlocks",
  "borrowing.ordinary.liveness.cfgEdges",
  "borrowing.ordinary.liveness.trackedCapabilities",
  "borrowing.ordinary.liveness.stateInsertions",
  "borrowing.ordinary.liveness.workItems",
  "codegen.exact_call.requests",
  "codegen.exact_call.cache_hits",
  "codegen.exact_call.cache_misses",
  "codegen.exact_call.body_visits",
  "codegen.exact_call.accepted",
  "codegen.exact_call.fallback",
  "codegen.exact_call.fallback.missing-body",
  "codegen.exact_call.fallback.work-budget",
  "codegen.exact_call.fallback.memory-budget",
  "codegen.exact_call.fallback.unsupported-alias",
  "codegen.exact_call.bailout.missing-body",
  "codegen.exact_call.bailout.work-budget",
  "codegen.exact_call.bailout.memory-budget",
  "codegen.exact_call.bailout.unsupported-alias",
  "codegen.exact_call.budget_exhaustion.per_body_work",
  "codegen.exact_call.budget_exhaustion.per_body_memory",
  "codegen.exact_call.budget_exhaustion.compile_wide_memory",
  "codegen.exact_call.analysis_operations",
  "codegen.exact_call.work_units",
  "codegen.exact_call.retained_bytes",
  `${stableFieldPrefix}.candidates`,
  `${stableFieldPrefix}.accepted`,
  `${stableFieldPrefix}.forwarded_loads`,
  ...fallbackCounters(stableFieldPrefix, STABLE_FIELD_FALLBACK_REASONS),
  `${mutableLanePrefix}.requested`,
  `${mutableLanePrefix}.accepted`,
  ...fallbackCounters(
    mutableLanePrefix,
    MUTABLE_SCALAR_AGGREGATE_LANE_ABI_FALLBACK_REASONS,
  ),
  ...dispositionCounters(
    scalarInitializerPrefix,
    SCALAR_AGGREGATE_INITIALIZER_DECISIONS,
  ),
  ...dispositionCounters(
    scalarParameterPrefix,
    SCALAR_AGGREGATE_PARAMETER_DECISIONS,
  ),
  `${safeArrayWhilePrefix}.requested`,
  `${safeArrayWhilePrefix}.accepted`,
  `${safeArrayWhilePrefix}.fallback.shape`,
  ...fallbackCounters(safeArrayWhilePrefix, ARRAY_LOOP_PROOF_FALLBACK_REASONS),
  `${rangeArrayScopePrefix}.requested`,
  `${rangeArrayScopePrefix}.accepted`,
  ...fallbackCounters(rangeArrayScopePrefix, ARRAY_LOOP_PROOF_FALLBACK_REASONS),
  `${intrinsicArrayPrefix}.requested`,
  `${intrinsicArrayPrefix}.accepted`,
  `${intrinsicArrayPrefix}.fallback.effectful`,
  `${intrinsicArrayPrefix}.fallback.shape`,
  `${intrinsicRangePrefix}.requested`,
  `${intrinsicRangePrefix}.accepted`,
  `${intrinsicRangePrefix}.fallback.effectful`,
  `${intrinsicRangePrefix}.fallback.shape`,
  `${exactIteratorPrefix}.requested`,
  `${exactIteratorPrefix}.accepted`,
  ...fallbackCounters(exactIteratorPrefix, EXACT_ITERATOR_FALLBACK_REASONS),
  `${identityGuardPrefix}.pairs`,
  `${identityGuardPrefix}.static_disjoint`,
  `${identityGuardPrefix}.emitted.immediate`,
  `${identityGuardPrefix}.emitted.deferred_default`,
  ...ORDINARY_IDENTITY_GUARD_REJECTION_REASONS.map(
    (reason) => `${identityGuardPrefix}.rejected.${reason}`,
  ),
  `${defaultGuardCompanionPrefix}.requested`,
  `${defaultGuardCompanionPrefix}.created`,
  `${defaultGuardCompanionPrefix}.reused`,
  `${defaultGuardCompanionPrefix}.compiled`,
  ...fallbackCounters(
    defaultGuardCompanionPrefix,
    DEFAULT_IDENTITY_GUARD_COMPANION_FALLBACK_REASONS,
  ),
];
