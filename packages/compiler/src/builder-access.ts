/**
 * Finite caller-facing promise for a private, locally fresh builder.
 *
 * The callable may mutate the destination while reading its other inputs, but
 * it cannot retain a reference-capable input in the destination or otherwise
 * publish it. Absence is the conservative default.
 */
export type BuilderAccess = {
  destinationParameterIndex: number;
};

/** Parser-only form, resolved to a parameter index with the declaration. */
export type BuilderAccessAttribute = {
  destinationParameterName: string;
};
