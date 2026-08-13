import type { Diagnostic } from "../../diagnostics/index.js";
import type { SymbolId } from "../ids.js";
import type { SymbolRef } from "../typing/symbol-ref.js";

export type BorrowAccessMode = "owned" | "shared" | "mutable";

/** A bounded local projection used to compare source-level places. */
export type PlaceProjection =
  | { kind: "field"; name: string }
  | { kind: "tuple"; index: number }
  | { kind: "index"; constant?: number; stable: boolean }
  | { kind: "discriminant" }
  | { kind: "dereference" }
  | { kind: "identity" };

export type BorrowPlace = {
  root: SymbolId;
  projections: readonly PlaceProjection[];
};

/** Whether a reference endpoint is stored inline or behind an allocation. */
export type BorrowEndpointAccess = "inline" | "dereferenced";

export const projectionsOverlap = (
  left: PlaceProjection,
  right: PlaceProjection,
): boolean => {
  if (left.kind !== right.kind) {
    if (
      left.kind === "discriminant" ||
      right.kind === "discriminant" ||
      left.kind === "dereference" ||
      right.kind === "dereference" ||
      left.kind === "identity" ||
      right.kind === "identity"
    ) {
      return false;
    }
    return true;
  }
  if (
    (left.kind === "discriminant" && right.kind === "discriminant") ||
    (left.kind === "dereference" && right.kind === "dereference") ||
    (left.kind === "identity" && right.kind === "identity")
  ) {
    return true;
  }
  if (left.kind === "field" && right.kind === "field") {
    return left.name === right.name;
  }
  if (left.kind === "tuple" && right.kind === "tuple") {
    return left.index === right.index;
  }
  if (left.kind !== "index" || right.kind !== "index") return true;
  return !(
    left.stable &&
    right.stable &&
    left.constant !== undefined &&
    right.constant !== undefined &&
    left.constant !== right.constant
  );
};

export const projectionPathsOverlap = (
  left: readonly PlaceProjection[],
  right: readonly PlaceProjection[],
): boolean => {
  const shorter = left.length <= right.length ? left : right;
  const longerPrefix = left.length <= right.length ? right : left;
  const shorterIsExactPrefix = shorter.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(longerPrefix[index]),
  );
  if (
    shorter.length < longerPrefix.length &&
    shorterIsExactPrefix &&
    longerPrefix
      .slice(shorter.length)
      .some((projection) => projection.kind === "dereference")
  ) {
    return false;
  }
  if (left[0]?.kind === "dereference" && right[0]?.kind !== "dereference") {
    return projectionPathsOverlap(left.slice(1), right);
  }
  if (right[0]?.kind === "dereference" && left[0]?.kind !== "dereference") {
    return projectionPathsOverlap(left, right.slice(1));
  }
  const leftDereference = left.findLastIndex(
    (projection) => projection.kind === "dereference",
  );
  const rightDereference = right.findLastIndex(
    (projection) => projection.kind === "dereference",
  );
  if (leftDereference >= 0 && rightDereference >= 0) {
    return projectionPathsOverlap(
      left.slice(leftDereference + 1),
      right.slice(rightDereference + 1),
    );
  }
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!projectionsOverlap(left[index]!, right[index]!)) return false;
  }
  const longer = left.length > right.length ? left : right;
  return (
    left.length === right.length ||
    !longer
      .slice(commonLength)
      .some((projection) => projection.kind === "dereference")
  );
};

export const projectionPathCovers = (
  prefix: readonly PlaceProjection[],
  path: readonly PlaceProjection[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(path[index]),
  ) &&
  (prefix.length === path.length ||
    !path
      .slice(prefix.length)
      .some((projection) => projection.kind === "dereference"));

export type RuntimeIdentityGuardOperand = {
  parameter: number;
  expression: number;
  place: BorrowPlace;
  display: string;
  identity: "allocation" | "storage" | "indexed-place";
  /** Projection from the argument allocation to the checked allocation. */
  allocationPath?: readonly PlaceProjection[];
};

export type RuntimeIdentityGuard = {
  call: number;
  target: SymbolRef;
  left: RuntimeIdentityGuardOperand;
  right: RuntimeIdentityGuardOperand;
  /** The callee evaluates omitted defaults before checking identity. */
  afterDefaults?: true;
  defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
  omittedParameters?: readonly number[];
};

export type BorrowingResult = {
  ordinaryMutationSummaries: ReadonlyMap<
    SymbolId,
    import("./ordinary-mutation-summary.js").OrdinaryMutationSummary
  >;
  defaultIdentityGuardTargets: ReadonlySet<SymbolId>;
  runtimeIdentityGuards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
  mutableStorageSymbols: ReadonlySet<SymbolId>;
  diagnostics: readonly Diagnostic[];
};

export const emptyBorrowingResult = (): BorrowingResult => ({
  ordinaryMutationSummaries: new Map(),
  defaultIdentityGuardTargets: new Set(),
  runtimeIdentityGuards: new Map(),
  mutableStorageSymbols: new Set(),
  diagnostics: [],
});
