import type { Diagnostic } from "../../diagnostics/index.js";
import type { SymbolId } from "../ids.js";

export type BorrowAccessMode = "owned" | "shared" | "mutable";

export type PlaceProjection =
  | { kind: "field"; name: string }
  | { kind: "tuple"; index: number }
  | { kind: "index"; constant?: number; stable: boolean }
  | { kind: "discriminant" }
  | { kind: "dereference" }
  | { kind: "identity" };

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
  returned: boolean;
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
};

export type BorrowEndpointAccess = "inline" | "dereferenced";

export type ReturnedTypeMatchingOrigin = ReturnedBorrowOrigin & {
  conditionId: string;
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
};

export type CallableBorrowContract = {
  parameters: readonly CallableParameterBorrowContract[];
  maySuspend: boolean;
  /**
   * Whether an explicitly borrowed result can carry provenance independently
   * of the callable's returned parameter origins.
   */
  borrowedResult?: "none" | "parameter" | "external";
  transfers?: readonly CallableBorrowTransfer[];
  scopedCallbacks?: readonly ScopedCallbackBorrowContract[];
};

export type BorrowPlace = {
  root: SymbolId;
  projections: readonly PlaceProjection[];
};

export type BorrowingResult = {
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  mutableStorageSymbols: ReadonlySet<SymbolId>;
  diagnostics: readonly Diagnostic[];
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
      });
    });
    contract.transfers?.forEach((transfer) => {
      transfers.push(transfer);
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
        returned: parameters.some((parameter) => parameter.returned),
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
    borrowedResult: contracts.some(
      (contract) =>
        contract.borrowedResult === "external" ||
        contract.borrowedResult === undefined,
    )
      ? "external"
      : contracts.some((contract) => contract.borrowedResult === "parameter")
        ? "parameter"
        : "none",
    ...(normalizedTransfers.length > 0
      ? { transfers: normalizedTransfers }
      : {}),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
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

const mergeReturnedOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
): Partial<CallableParameterBorrowContract> => {
  const origins = Array.from(
    new Map(
      parameters
        .flatMap((parameter) => parameter.returnedOrigins ?? [])
        .map((origin) => [JSON.stringify(origin), origin]),
    ).values(),
  );
  return origins.length > 0 ? { returnedOrigins: origins } : {};
};

const mergeReturnedSharedOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
): Partial<CallableParameterBorrowContract> => {
  const [first, ...remaining] = parameters.map(
    (parameter) => parameter.returnedSharedOrigins ?? [],
  );
  const origins = (first ?? []).filter((origin) =>
    remaining.every((candidates) =>
      candidates.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(origin),
      ),
    ),
  );
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
                JSON.stringify(candidate) === JSON.stringify(origin),
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
        .map((path) => [JSON.stringify(path), path]),
    ).values(),
  );
  return paths.length > 0 ? { [key]: paths } : {};
};

export const emptyBorrowingResult = (): BorrowingResult => ({
  callables: new Map(),
  mutableStorageSymbols: new Set(),
  diagnostics: [],
});
