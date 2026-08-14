/**
 * Finite caller-facing promise for an overlap-safe mutating callable.
 *
 * The callable fully reads or snapshots every other reference-capable input
 * before its first write through the destination parameter. Absence is the
 * conservative default.
 */
export type StagedAccess = {
  destinationParameterIndex: number;
};

/** Parser-only form, resolved to a parameter index with the declaration. */
export type StagedAccessAttribute = {
  destinationParameterName: string;
};
