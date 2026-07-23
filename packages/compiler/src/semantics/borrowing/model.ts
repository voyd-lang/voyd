import type { Diagnostic } from "../../diagnostics/index.js";
import type { HirExprId, SourceSpan, SymbolId } from "../ids.js";

export type BorrowAccessMode = "owned" | "shared" | "mutable";

export type PlaceProjection =
  | { kind: "field"; name: string }
  | { kind: "tuple"; index: number }
  | { kind: "index"; constant?: number; stable: boolean };

export type CallableParameterBorrowContract = {
  access: BorrowAccessMode;
  retained: boolean;
  returned: boolean;
  retainedPaths?: readonly (readonly PlaceProjection[])[];
  externalRetainedPaths?: readonly (readonly PlaceProjection[])[];
  borrowedRetainedPaths?: readonly (readonly PlaceProjection[])[];
  returnedPaths?: readonly (readonly PlaceProjection[])[];
  returnedOrigins?: readonly ReturnedBorrowOrigin[];
  returnedBorrowedOrigins?: readonly ReturnedBorrowOrigin[];
  returnedSharedOrigins?: readonly ReturnedBorrowOrigin[];
  invalidatedPaths?: readonly (readonly PlaceProjection[])[];
  defaultOrigins?: readonly number[];
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
};

export type ScopedCallbackBorrowContract = {
  callbackParameter: number;
  callbackValueParameter: number;
  access: "shared" | "mutable";
  callbackPath?: readonly string[];
};

export type CallableBorrowContract = {
  parameters: readonly CallableParameterBorrowContract[];
  maySuspend: boolean;
  transfers?: readonly CallableBorrowTransfer[];
  scopedCallbacks?: readonly ScopedCallbackBorrowContract[];
};

export type BorrowPlace = {
  root: SymbolId;
  projections: readonly PlaceProjection[];
};

export type BorrowFact =
  | {
      kind: "alias";
      symbol: SymbolId;
      place: BorrowPlace;
      access: "shared" | "mutable";
      span: SourceSpan;
      lastUse?: SourceSpan;
    }
  | {
      kind: "capability-downgrade";
      place: BorrowPlace;
      span: SourceSpan;
    }
  | {
      kind: "call-borrow";
      expr: HirExprId;
      place: BorrowPlace;
      access: "shared" | "mutable";
    };

export type BorrowingResult = {
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  facts: readonly BorrowFact[];
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
      return {
        access,
        retained: parameters.some((parameter) => parameter.retained),
        returned: parameters.some((parameter) => parameter.returned),
        ...mergeProjectionPaths(parameters, "retainedPaths"),
        ...mergeProjectionPaths(parameters, "externalRetainedPaths"),
        ...mergeProjectionPaths(parameters, "borrowedRetainedPaths"),
        ...mergeProjectionPaths(parameters, "returnedPaths"),
        ...mergeReturnedOrigins(parameters),
        ...mergeReturnedBorrowedOrigins(parameters),
        ...mergeReturnedSharedOrigins(parameters),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
        ...(() => {
          const defaultOrigins = Array.from(
            new Set(
              parameters.flatMap((parameter) => parameter.defaultOrigins ?? []),
            ),
          );
          return defaultOrigins.length > 0 ? { defaultOrigins } : {};
        })(),
      };
    }),
    maySuspend: contracts.some((contract) => contract.maySuspend),
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

const mergeReturnedBorrowedOrigins = (
  parameters: readonly CallableParameterBorrowContract[],
): Partial<CallableParameterBorrowContract> => {
  const origins = Array.from(
    new Map(
      parameters
        .flatMap((parameter) => parameter.returnedBorrowedOrigins ?? [])
        .map((origin) => [JSON.stringify(origin), origin]),
    ).values(),
  );
  return origins.length > 0 ? { returnedBorrowedOrigins: origins } : {};
};

const mergeProjectionPaths = (
  parameters: readonly CallableParameterBorrowContract[],
  key:
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
            : [[]];
        })
        .map((path) => [JSON.stringify(path), path]),
    ).values(),
  );
  return paths.length > 0 ? { [key]: paths } : {};
};

export const emptyBorrowingResult = (): BorrowingResult => ({
  callables: new Map(),
  facts: [],
  diagnostics: [],
});
