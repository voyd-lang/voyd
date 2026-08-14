/**
 * Finite caller-facing identity information for a callable result.
 *
 * Absence is deliberately the conservative default. These cases describe
 * only the result's outer identity; they do not recursively detach or freshen
 * values reachable through the result.
 */
export type ResultIdentity =
  | { kind: "detached" }
  | { kind: "fresh" }
  | { kind: "same-place"; parameterIndex: number };

export type ResultIdentityAttribute = Extract<
  ResultIdentity,
  { kind: "detached" | "fresh" }
>;
