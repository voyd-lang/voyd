import type { Diagnostic } from "../../diagnostics/index.js";
import type { SymbolId } from "../ids.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { LoanAnalysisMode } from "./capability.js";

export type BorrowAccessMode = "owned" | "shared" | "mutable";

export type PlaceProjection =
  | { kind: "field"; name: string }
  | { kind: "tuple"; index: number }
  | { kind: "index"; constant?: number; stable: boolean }
  | {
      kind: "region";
      scope: string;
      name: string;
      disjoint: readonly string[];
    }
  | { kind: "discriminant" }
  | { kind: "dereference" }
  | { kind: "identity" };

const projectionPathKey = (path: readonly PlaceProjection[]): string =>
  path
    .map((projection) => {
      switch (projection.kind) {
        case "field":
          return `field:${projection.name}`;
        case "tuple":
          return `tuple:${projection.index}`;
        case "index":
          return `index:${projection.stable ? "stable" : "unstable"}:${projection.constant ?? ""}`;
        case "region":
          return `region:${projection.scope}:${projection.name}:${[...projection.disjoint].sort().join(",")}`;
        case "discriminant":
          return "discriminant";
        case "dereference":
          return "dereference";
        case "identity":
          return "identity";
      }
    })
    .join("/");

export const projectionsOverlap = (
  left: PlaceProjection,
  right: PlaceProjection,
): boolean => {
  if (left.kind !== right.kind) {
    if (left.kind === "region" || right.kind === "region") {
      return true;
    }
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
  if (left.kind === "region" && right.kind === "region") {
    if (left.scope !== right.scope) {
      return true;
    }
    return (
      left.name === right.name ||
      (!left.disjoint.includes(right.name) &&
        !right.disjoint.includes(left.name))
    );
  }
  if (left.kind === "field" && right.kind === "field") {
    return left.name === right.name;
  }
  if (left.kind === "tuple" && right.kind === "tuple") {
    return left.index === right.index;
  }
  if (left.kind !== "index" || right.kind !== "index") {
    return true;
  }
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
  const prefixLonger = left.length <= right.length ? right : left;
  const shorterIsExactPrefix = shorter.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(prefixLonger[index]),
  );
  if (
    shorter.length < prefixLonger.length &&
    shorterIsExactPrefix &&
    prefixLonger
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
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (!projectionsOverlap(left[index]!, right[index]!)) {
      return false;
    }
  }
  const longer = left.length > right.length ? left : right;
  return (
    left.length === right.length ||
    !longer
      .slice(length)
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

/**
 * An allocation-mapped region contains its inline slots. A borrow formed from
 * one such slot may cross the slot's final handle dereference, but the mapping
 * does not cover any deeper referenced allocation.
 */
export const mappedAllocationCoversReturnedBorrow = (
  mappedPlace: readonly PlaceProjection[],
  path: readonly PlaceProjection[],
): boolean => {
  if (
    mappedPlace.at(-1)?.kind !== "dereference" ||
    path.at(-1)?.kind !== "dereference" ||
    mappedPlace.length >= path.length
  ) {
    return false;
  }
  if (
    !mappedPlace.every(
      (projection, index) =>
        JSON.stringify(projection) === JSON.stringify(path[index]),
    )
  ) {
    return false;
  }
  return !path
    .slice(mappedPlace.length, -1)
    .some((projection) => projection.kind === "dereference");
};

export const translateProjectionPath = ({
  result,
  source,
  requested,
}: {
  result: readonly PlaceProjection[];
  source: readonly PlaceProjection[];
  requested: readonly PlaceProjection[];
}): readonly PlaceProjection[] | undefined => {
  const common = Math.min(result.length, requested.length);
  for (let index = 0; index < common; index += 1) {
    if (!projectionsOverlap(result[index]!, requested[index]!)) {
      return undefined;
    }
  }
  return requested.length < result.length
    ? source
    : [...source, ...requested.slice(result.length)];
};

export type CallableParameterBorrowContract = {
  access: BorrowAccessMode;
  readPaths?: readonly (readonly PlaceProjection[])[];
  writePaths?: readonly (readonly PlaceProjection[])[];
  runtimeCheckedWrites?: true;
  retained: boolean;
  /** A public abstraction may retain ordinary values but never explicit borrows. */
  retainedUnlessBorrowed?: true;
  returned: boolean;
  /**
   * The result is a fresh outer value that conservatively contains returned
   * provenance from this parameter rather than being the parameter itself.
   */
  returnedAggregate?: true;
  retainedPaths?: readonly (readonly PlaceProjection[])[];
  externalRetainedPaths?: readonly (readonly PlaceProjection[])[];
  borrowedRetainedPaths?: readonly (readonly PlaceProjection[])[];
  returnedPaths?: readonly (readonly PlaceProjection[])[];
  returnedOrigins?: readonly ReturnedBorrowOrigin[];
  returnedSharedOrigins?: readonly ReturnedBorrowOrigin[];
  returnedTypeMatchingOrigins?: readonly ReturnedTypeMatchingOrigin[];
  accessIfResultTypeDiffers?: BorrowTypeComparison;
  invalidatedPaths?: readonly (readonly PlaceProjection[])[];
  defaultOrigins?: readonly DefaultBorrowOrigin[];
  defaultReadOrigins?: readonly DefaultBorrowAccessOrigin[];
  defaultWriteOrigins?: readonly DefaultBorrowAccessOrigin[];
  defaultExternalOrigins?: readonly ExternalReturnedOrigin[];
  defaultExternalReturnedOrigins?: readonly ExternalReturnedOrigin[];
  defaultExternalRead?: true;
  defaultExternalWrite?: true;
  /**
   * Records the only default-value presence fact that is safe to consume
   * without the defining module's HIR.
   */
  defaultBorrowedResult?: "none";
  /** Default-value projections that are definitely free of active loans. */
  defaultNoBorrowPaths?: readonly (readonly PlaceProjection[])[];
};

export type DefaultBorrowOrigin = {
  parameter: number;
  source: readonly PlaceProjection[];
  result: readonly PlaceProjection[];
  endpointAccess?: BorrowEndpointAccess;
};

export type DefaultBorrowAccessOrigin = {
  parameter: number;
  path: readonly PlaceProjection[];
};

export type CallableBorrowTransfer = {
  sourceParameter: number;
  destinationParameter: number;
  sourcePath?: readonly PlaceProjection[];
  destinationPath?: readonly PlaceProjection[];
  sourceInvalidated?: true;
  borrowsSource?: true;
  conservative?: true;
};

const MAX_BORROW_TRANSFER_DEPTH = 8;
const MAX_BORROW_TRANSFERS_PER_PARAMETER_PAIR = 32;

export type ReturnedBorrowOrigin = {
  source: readonly PlaceProjection[];
  result: readonly PlaceProjection[];
  endpointAccess?: BorrowEndpointAccess;
  /**
   * This explicit shared/borrowed origin contributes no active loan when its
   * parameter's default is used. It does not suppress ordinary alias
   * provenance. Kept on the origin so privacy abstraction can redact its
   * source path without broadening the fact to sibling default projections.
   */
  defaultNoBorrow?: true;
};

export type BorrowEndpointAccess = "inline" | "dereferenced";

export type ReturnedTypeMatchingOrigin = ReturnedBorrowOrigin & {
  conditionId: string;
};

export type ExternalReturnedOrigin = {
  result: readonly PlaceProjection[];
  endpointAccess?: BorrowEndpointAccess;
  /** The origin is a fresh allocation owned by this call result. */
  fresh?: true;
};

export type BorrowTypeComparison = {
  conditionId: string;
  parameter: number;
  sourcePath: readonly PlaceProjection[];
  resultPath: readonly PlaceProjection[];
  endpointAccess?: BorrowEndpointAccess;
};

export const borrowTypeConditionId = ({
  parameter,
  sourcePath,
  resultPath,
  endpointAccess,
}: Omit<BorrowTypeComparison, "conditionId">): string =>
  JSON.stringify([parameter, sourcePath, resultPath, endpointAccess ?? null]);

export type ScopedCallbackBorrowContract = {
  callbackParameter: number;
  callbackValueParameter: number;
  access: "shared" | "mutable";
  callbackPath?: readonly string[];
  defaultCallbackBehavior?: "safe" | "escapes" | "unknown";
};

export type CallableResultInvocation = {
  parameter: number;
  source: readonly PlaceProjection[];
  callbackResult: readonly PlaceProjection[];
  callbackResultType?: { moduleId: string; symbol: SymbolId };
  result: readonly PlaceProjection[];
};

export type CallableBorrowContract = {
  parameters: readonly CallableParameterBorrowContract[];
  maySuspend: boolean;
  /** Every successful return produces a fresh root allocation. */
  freshResult?: true;
  /**
   * Versioned ABI used by guarded calls whose omitted arguments are evaluated
   * in the callee. This is serialized so separately compiled callers only use
   * a protocol explicitly advertised by the target.
   */
  defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
  /**
   * Whether an explicitly borrowed result can carry provenance independently
   * of the callable's returned parameter origins.
   */
  borrowedResult?: "none" | "parameter" | "external";
  externalReturnedOrigins?: readonly ExternalReturnedOrigin[];
  externalRead?: true;
  externalWrite?: true;
  transfers?: readonly CallableBorrowTransfer[];
  scopedCallbacks?: readonly ScopedCallbackBorrowContract[];
  /**
   * Callable-valued parameter projections whose invocation result can flow to
   * this callable's result. Callers substitute the concrete callback result.
   */
  callableResultInvocations?: readonly CallableResultInvocation[];
  /**
   * Public open-dispatch view for a concrete trait implementation. Direct
   * concrete calls continue to use the implementation footprint above.
   */
  dynamicDispatch?: CallableBorrowContract;
};

export const runtimeIdentityGuardParameterCanEscape = (
  parameter: CallableParameterBorrowContract | undefined,
): boolean =>
  parameter === undefined ||
  (parameter.borrowedRetainedPaths?.length ?? 0) > 0 ||
  (parameter.returnedSharedOrigins?.length ?? 0) > 0;

export const callableContractAllowsRuntimeIdentityGuards = (
  contract: CallableBorrowContract,
): boolean =>
  !contract.maySuspend && !contract.externalRead && !contract.externalWrite;

/**
 * Callable-level capability used for publishing the deferred-default ABI.
 * Caller-specific place and type checks remain in body analysis.
 */
export const callableContractHasGuardableAccessPair = (
  contract: CallableBorrowContract,
): boolean => {
  if (!callableContractAllowsRuntimeIdentityGuards(contract)) {
    return false;
  }
  const identityShape = (
    parameter: CallableParameterBorrowContract,
  ): "dereferenced" | "inline" | undefined => {
    if (runtimeIdentityGuardParameterCanEscape(parameter)) {
      return undefined;
    }
    const paths = [
      ...(parameter.readPaths ?? []),
      ...(parameter.writePaths ?? []),
    ];
    if (paths.length === 0) {
      return undefined;
    }
    const dereferenced = new Set(
      paths.map((path) =>
        path.some((projection) => projection.kind === "dereference"),
      ),
    );
    if (dereferenced.size !== 1) {
      return undefined;
    }
    return dereferenced.has(true) ? "dereferenced" : "inline";
  };
  const shapes = contract.parameters.map(identityShape);
  return contract.parameters.some(
    (parameter, index) =>
      (parameter.writePaths?.length ?? 0) > 0 &&
      shapes[index] !== undefined &&
      contract.parameters.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          shapes[candidateIndex] === shapes[index] &&
          ((candidate.readPaths?.length ?? 0) > 0 ||
            (candidate.writePaths?.length ?? 0) > 0),
      ),
  );
};

export const callableDefaultsPreserveRuntimeIdentity = ({
  contract,
  omittedParameters,
  writePreservesIdentity,
}: {
  contract: CallableBorrowContract;
  omittedParameters: readonly number[];
  writePreservesIdentity: (origin: DefaultBorrowAccessOrigin) => boolean;
}): boolean =>
  omittedParameters.every((parameterIndex) => {
    const parameter = contract.parameters[parameterIndex];
    return (
      parameter !== undefined &&
      !parameter.defaultExternalWrite &&
      (parameter.defaultWriteOrigins?.every(writePreservesIdentity) ?? true)
    );
  });

export type BorrowPlace = {
  root: SymbolId;
  projections: readonly PlaceProjection[];
};

export type CheckedBorrowRegion = {
  name: string;
  parameter?: number;
  place?: readonly PlaceProjection[];
};

export type CheckedNamedBorrowContract = {
  scope: string;
  declaration: SymbolId;
  trait: SymbolId;
  implementation?: SymbolId;
  regions: readonly CheckedBorrowRegion[];
  disjoint: readonly (readonly [string, string])[];
  reads: readonly string[];
  mutates: readonly string[];
  returnsFrom: readonly string[];
};

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
  target: { moduleId: string; symbol: number };
  left: RuntimeIdentityGuardOperand;
  right: RuntimeIdentityGuardOperand;
  /**
   * Omitted defaults are evaluated in the callee. This marker prevents
   * lowering the guard at an earlier caller-side activation point.
   */
  afterDefaults?: true;
  /** Protocol advertised by the resolved callable for deferred checking. */
  defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
  /** The exact omitted-default call shape that requires this guard. */
  omittedParameters?: readonly number[];
};

export type BorrowingResult = {
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  capabilities: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  namedContracts: ReadonlyMap<SymbolId, CheckedNamedBorrowContract>;
  runtimeIdentityGuards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
  mutableStorageSymbols: ReadonlySet<SymbolId>;
  diagnostics: readonly Diagnostic[];
  /** Architecture telemetry; not part of dependency/codegen projections. */
  analysisMetrics?: {
    fullFactsMaterialized: number;
    fullFactSymbols: readonly SymbolId[];
  };
  summaryDemand?: {
    totalCallables: number;
    demandedCallables: number;
    skippedTrivialCallables: number;
    worklistEdges: number;
    worklistIterations: number;
    evaluations: number;
    reusedCallables: number;
    demandedSymbols: ReadonlySet<SymbolId>;
  };
  /** Process-local callable boundary for incremental invalidation (V-465). */
  queries?: ReadonlyMap<
    SymbolId,
    {
      input: string;
      dependencies: readonly SymbolRef[];
      /** Exact canonical contracts observed for dependency query outputs. */
      dependencyOutputs: readonly (readonly [
        string,
        CallableBorrowContract | null | string,
      ])[];
      output: CallableBorrowContract;
    }
  >;
};

export const mergeCallableBorrowContracts = (
  contracts: readonly CallableBorrowContract[],
): CallableBorrowContract | undefined => {
  if (contracts.length === 0) {
    return undefined;
  }
  const parameterCount = Math.max(
    ...contracts.map((contract) => contract.parameters.length),
  );
  const scopedCallbacks = new Map<string, ScopedCallbackBorrowContract>();
  const callableResultInvocations = new Map<string, CallableResultInvocation>();
  const transfers: CallableBorrowTransfer[] = [];
  contracts.forEach((contract) => {
    contract.scopedCallbacks?.forEach((callback) => {
      const key = `${callback.callbackParameter}:${callback.callbackValueParameter}:${callback.callbackPath?.join(".") ?? ""}`;
      const existing = scopedCallbacks.get(key);
      scopedCallbacks.set(key, {
        ...callback,
        access:
          existing?.access === "mutable" || callback.access === "mutable"
            ? "mutable"
            : "shared",
        ...(existing?.defaultCallbackBehavior === "escapes" ||
        callback.defaultCallbackBehavior === "escapes"
          ? { defaultCallbackBehavior: "escapes" as const }
          : existing?.defaultCallbackBehavior === "unknown" ||
              callback.defaultCallbackBehavior === "unknown"
            ? { defaultCallbackBehavior: "unknown" as const }
            : existing?.defaultCallbackBehavior === "safe" ||
                callback.defaultCallbackBehavior === "safe"
              ? { defaultCallbackBehavior: "safe" as const }
              : {}),
      });
    });
    contract.transfers?.forEach((transfer) => {
      transfers.push(transfer);
    });
    contract.callableResultInvocations?.forEach((invocation) => {
      callableResultInvocations.set(JSON.stringify(invocation), invocation);
    });
  });
  const normalizedTransfers = normalizeCallableBorrowTransfers(transfers);
  return {
    parameters: Array.from({ length: parameterCount }, (_entry, index) => {
      const parameters = contracts.flatMap((contract) => {
        const parameter = contract.parameters[index];
        return parameter ? [parameter] : [];
      });
      const access = parameters.some(
        (parameter) => parameter.access === "mutable",
      )
        ? "mutable"
        : parameters.some((parameter) => parameter.access === "shared")
          ? "shared"
          : "owned";
      const invalidatedPaths = intersectProjectionPaths(
        parameters.map((parameter) => parameter.invalidatedPaths ?? []),
      );
      const accessedParameters = parameters.filter(
        (parameter) =>
          (parameter.readPaths?.length ?? 0) > 0 ||
          (parameter.writePaths?.length ?? 0) > 0,
      );
      const accessConditions = new Map(
        accessedParameters.flatMap((parameter) =>
          parameter.accessIfResultTypeDiffers
            ? [
                [
                  JSON.stringify(parameter.accessIfResultTypeDiffers),
                  parameter.accessIfResultTypeDiffers,
                ] as const,
              ]
            : [],
        ),
      );
      const conditionalAccess =
        accessedParameters.length > 0 &&
        accessConditions.size === 1 &&
        accessedParameters.every(
          (parameter) => parameter.accessIfResultTypeDiffers !== undefined,
        )
          ? Array.from(accessConditions.values())[0]
          : undefined;
      const retainingParameters = parameters.filter(
        (parameter) => parameter.retained,
      );
      const returningParameters = parameters.filter(
        (parameter) => parameter.returned,
      );
      const retainedUnlessBorrowed =
        retainingParameters.length > 0 &&
        retainingParameters.every(
          (parameter) => parameter.retainedUnlessBorrowed === true,
        );
      return {
        access,
        ...mergeProjectionPaths(parameters, "readPaths"),
        ...mergeProjectionPaths(parameters, "writePaths"),
        ...(parameters.every(
          (parameter) => parameter.runtimeCheckedWrites === true,
        )
          ? { runtimeCheckedWrites: true as const }
          : {}),
        retained: parameters.some((parameter) => parameter.retained),
        ...(retainedUnlessBorrowed
          ? { retainedUnlessBorrowed: true as const }
          : {}),
        returned: parameters.some((parameter) => parameter.returned),
        ...(returningParameters.length > 0 &&
        returningParameters.every(
          (parameter) => parameter.returnedAggregate === true,
        )
          ? { returnedAggregate: true as const }
          : {}),
        ...mergeReturnedTypeMatchingOrigins(parameters, index),
        ...(conditionalAccess
          ? { accessIfResultTypeDiffers: conditionalAccess }
          : {}),
        ...mergeProjectionPaths(parameters, "retainedPaths"),
        ...mergeProjectionPaths(parameters, "externalRetainedPaths"),
        ...mergeProjectionPaths(parameters, "borrowedRetainedPaths"),
        ...mergeProjectionPaths(parameters, "returnedPaths"),
        ...mergeReturnedOrigins(parameters),
        ...mergeReturnedSharedOrigins(parameters),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
        ...(() => {
          const defaultOrigins = Array.from(
            new Map(
              parameters
                .flatMap((parameter) => parameter.defaultOrigins ?? [])
                .map((origin) => [JSON.stringify(origin), origin]),
            ).values(),
          );
          return defaultOrigins.length > 0 ? { defaultOrigins } : {};
        })(),
        ...(() => {
          const defaultReadOrigins = Array.from(
            new Map(
              parameters
                .flatMap((parameter) => parameter.defaultReadOrigins ?? [])
                .map((origin) => [JSON.stringify(origin), origin]),
            ).values(),
          );
          return defaultReadOrigins.length > 0 ? { defaultReadOrigins } : {};
        })(),
        ...(() => {
          const defaultWriteOrigins = Array.from(
            new Map(
              parameters
                .flatMap((parameter) => parameter.defaultWriteOrigins ?? [])
                .map((origin) => [JSON.stringify(origin), origin]),
            ).values(),
          );
          return defaultWriteOrigins.length > 0 ? { defaultWriteOrigins } : {};
        })(),
        ...(() => {
          const defaultExternalOrigins = Array.from(
            new Map(
              parameters
                .flatMap((parameter) => parameter.defaultExternalOrigins ?? [])
                .map((origin) => [JSON.stringify(origin), origin]),
            ).values(),
          );
          return defaultExternalOrigins.length > 0
            ? { defaultExternalOrigins }
            : {};
        })(),
        ...(() => {
          const defaultExternalReturnedOrigins = Array.from(
            new Map(
              parameters
                .flatMap(
                  (parameter) => parameter.defaultExternalReturnedOrigins ?? [],
                )
                .map((origin) => [JSON.stringify(origin), origin]),
            ).values(),
          );
          return defaultExternalReturnedOrigins.length > 0
            ? { defaultExternalReturnedOrigins }
            : {};
        })(),
        ...(parameters.some((parameter) => parameter.defaultExternalRead)
          ? { defaultExternalRead: true as const }
          : {}),
        ...(parameters.some((parameter) => parameter.defaultExternalWrite)
          ? { defaultExternalWrite: true as const }
          : {}),
        ...(parameters.length === contracts.length &&
        parameters.every(
          (parameter) => parameter.defaultBorrowedResult === "none",
        )
          ? { defaultBorrowedResult: "none" as const }
          : {}),
        ...(() => {
          const defaultNoBorrowPaths = intersectProjectionPaths(
            parameters.map((parameter) => parameter.defaultNoBorrowPaths ?? []),
          );
          return parameters.length === contracts.length &&
            defaultNoBorrowPaths.length > 0
            ? { defaultNoBorrowPaths }
            : {};
        })(),
      };
    }),
    maySuspend: contracts.some((contract) => contract.maySuspend),
    ...(contracts.every((contract) => contract.freshResult === true)
      ? { freshResult: true as const }
      : {}),
    ...(contracts.every(
      (contract) =>
        contract.defaultIdentityGuardProtocol === "presence-conflict-bit-v1",
    )
      ? {
          defaultIdentityGuardProtocol: "presence-conflict-bit-v1" as const,
        }
      : {}),
    ...(contracts.some((contract) => contract.externalRead)
      ? { externalRead: true as const }
      : {}),
    ...(contracts.some((contract) => contract.externalWrite)
      ? { externalWrite: true as const }
      : {}),
    borrowedResult: contracts.some(
      (contract) =>
        contract.borrowedResult === "external" ||
        contract.borrowedResult === undefined,
    )
      ? "external"
      : contracts.some((contract) => contract.borrowedResult === "parameter")
        ? "parameter"
        : "none",
    ...(() => {
      const externalReturnedOrigins = Array.from(
        new Map(
          contracts
            .flatMap((contract) => contract.externalReturnedOrigins ?? [])
            .map((origin) => [JSON.stringify(origin), origin]),
        ).values(),
      );
      return externalReturnedOrigins.length > 0
        ? { externalReturnedOrigins }
        : {};
    })(),
    ...(normalizedTransfers.length > 0
      ? { transfers: normalizedTransfers }
      : {}),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
    ...(callableResultInvocations.size > 0
      ? {
          callableResultInvocations: Array.from(
            callableResultInvocations.values(),
          ),
        }
      : {}),
  };
};

export const normalizeCallableBorrowTransfers = (
  transfers: readonly CallableBorrowTransfer[] | undefined,
): readonly CallableBorrowTransfer[] => {
  const groups = new Map<string, CallableBorrowTransfer[]>();
  transfers?.forEach((transfer) => {
    const key = `${transfer.sourceParameter}:${transfer.destinationParameter}`;
    const group = groups.get(key) ?? [];
    group.push(transfer);
    groups.set(key, group);
  });

  return Array.from(groups.values()).flatMap((group) => {
    const first = group[0]!;
    const unique = Array.from(
      new Map(
        group.map((transfer) => [JSON.stringify(transfer), transfer]),
      ).values(),
    );
    const requiresWidening =
      unique.some((transfer) => transfer.conservative) ||
      unique.length > MAX_BORROW_TRANSFERS_PER_PARAMETER_PAIR ||
      unique.some(
        (transfer) =>
          (transfer.sourcePath?.length ?? 0) > MAX_BORROW_TRANSFER_DEPTH ||
          (transfer.destinationPath?.length ?? 0) > MAX_BORROW_TRANSFER_DEPTH,
      );
    if (!requiresWidening) {
      return unique;
    }
    return [
      {
        sourceParameter: first.sourceParameter,
        destinationParameter: first.destinationParameter,
        sourcePath: [],
        destinationPath: [],
        ...(unique.every((transfer) => transfer.sourceInvalidated)
          ? { sourceInvalidated: true as const }
          : {}),
        ...(unique.some((transfer) => transfer.borrowsSource)
          ? { borrowsSource: true as const }
          : {}),
        conservative: true as const,
      },
    ];
  });
};

const intersectProjectionPaths = (
  pathSets: readonly (readonly (readonly PlaceProjection[])[])[],
): readonly (readonly PlaceProjection[])[] => {
  const [first, ...remaining] = pathSets;
  if (!first || first.length === 0) {
    return [];
  }
  return first.filter((path) =>
    remaining.every((paths) =>
      paths.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(path),
      ),
    ),
  );
};

const returnedOriginKey = (origin: ReturnedBorrowOrigin): string =>
  JSON.stringify([
    origin.source,
    origin.result,
    origin.endpointAccess ?? "inline",
  ]);

const mergeReturnedOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
): Partial<CallableParameterBorrowContract> => {
  const originsByKey = new Map<string, ReturnedBorrowOrigin[]>();
  parameters
    .flatMap((parameter) => parameter.returnedOrigins ?? [])
    .forEach((origin) => {
      const key = returnedOriginKey(origin);
      originsByKey.set(key, [...(originsByKey.get(key) ?? []), origin]);
    });
  const origins = Array.from(originsByKey.values()).map((matching) => {
    const origin = matching[0]!;
    const { defaultNoBorrow: _defaultNoBorrow, ...base } = origin;
    return {
      ...base,
      ...(matching.length > 0 &&
      matching.every((candidate) => candidate.defaultNoBorrow === true)
        ? { defaultNoBorrow: true as const }
        : {}),
    };
  });
  return origins.length > 0 ? { returnedOrigins: origins } : {};
};

const mergeReturnedSharedOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
): Partial<CallableParameterBorrowContract> => {
  const [first, ...remaining] = parameters.map(
    (parameter) => parameter.returnedSharedOrigins ?? [],
  );
  const remainingByKey = remaining.map(
    (origins) =>
      new Map(origins.map((origin) => [returnedOriginKey(origin), origin])),
  );
  const origins = (first ?? []).flatMap((origin) => {
    const key = returnedOriginKey(origin);
    const matching = remainingByKey.map((candidates) => candidates.get(key));
    if (matching.some((candidate) => candidate === undefined)) {
      return [];
    }
    const { defaultNoBorrow: _defaultNoBorrow, ...base } = origin;
    return [
      {
        ...base,
        ...([origin, ...matching].every(
          (candidate) => candidate?.defaultNoBorrow === true,
        )
          ? { defaultNoBorrow: true as const }
          : {}),
      },
    ];
  });
  return origins.length > 0 ? { returnedSharedOrigins: origins } : {};
};

const mergeReturnedTypeMatchingOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
  parameter: number,
): Partial<CallableParameterBorrowContract> => {
  const returnedOrigins = parameters.flatMap(
    (parameter) => parameter.returnedOrigins ?? [],
  );
  const origins = Array.from(
    new Map(
      returnedOrigins
        .flatMap((origin) => {
          const providers = parameters.filter((parameter) =>
            parameter.returnedOrigins?.some(
              (candidate) =>
                returnedOriginKey(candidate) === returnedOriginKey(origin),
            ),
          );
          const conditions = providers.flatMap(
            (parameter) =>
              parameter.returnedTypeMatchingOrigins?.filter(
                (candidate) =>
                  JSON.stringify(candidate.source) ===
                    JSON.stringify(origin.source) &&
                  JSON.stringify(candidate.result) ===
                    JSON.stringify(origin.result) &&
                  candidate.endpointAccess === origin.endpointAccess,
              ) ?? [],
          );
          if (
            providers.length === 0 ||
            conditions.length !== providers.length
          ) {
            return [];
          }
          return [
            {
              ...origin,
              conditionId: borrowTypeConditionId({
                parameter,
                sourcePath: origin.source,
                resultPath: origin.result,
                endpointAccess: origin.endpointAccess,
              }),
            },
          ];
        })
        .map((origin) => [JSON.stringify(origin), origin]),
    ).values(),
  );
  return origins.length > 0 ? { returnedTypeMatchingOrigins: origins } : {};
};

const mergeProjectionPaths = (
  parameters: readonly CallableParameterBorrowContract[],
  key:
    | "readPaths"
    | "writePaths"
    | "retainedPaths"
    | "externalRetainedPaths"
    | "borrowedRetainedPaths"
    | "returnedPaths",
): Partial<CallableParameterBorrowContract> => {
  const paths = Array.from(
    new Map(
      parameters
        .flatMap((parameter) => {
          const active =
            key === "retainedPaths"
              ? parameter.retained
              : key === "returnedPaths"
                ? parameter.returned
                : parameter[key] !== undefined;
          if (!active) {
            return [];
          }
          return parameter[key] && parameter[key]!.length > 0
            ? parameter[key]!
            : key === "readPaths" || key === "writePaths"
              ? []
              : [[]];
        })
        .map((path) => [projectionPathKey(path), path]),
    ).values(),
  );
  paths.sort(
    (left, right) =>
      left.length - right.length ||
      projectionPathKey(left).localeCompare(projectionPathKey(right)),
  );
  return paths.length > 0 ? { [key]: paths } : {};
};

export const emptyBorrowingResult = (): BorrowingResult => ({
  callables: new Map(),
  capabilities: new Map(),
  namedContracts: new Map(),
  runtimeIdentityGuards: new Map(),
  mutableStorageSymbols: new Set(),
  diagnostics: [],
});
