import type { Diagnostic } from "../../diagnostics/index.js";
import type {
  HirExprId,
  SourceSpan,
  SymbolId,
} from "../ids.js";

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
  returnedPaths?: readonly (readonly PlaceProjection[])[];
  returnedOrigins?: readonly ReturnedBorrowOrigin[];
  defaultOrigins?: readonly number[];
};

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
  contracts.forEach((contract) =>
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
    }),
  );
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
      return {
        access,
        retained: parameters.some((parameter) => parameter.retained),
        returned: parameters.some((parameter) => parameter.returned),
        ...mergeProjectionPaths(parameters, "retainedPaths"),
        ...mergeProjectionPaths(parameters, "returnedPaths"),
        ...mergeReturnedOrigins(parameters),
        ...(() => {
          const defaultOrigins = Array.from(
            new Set(
              parameters.flatMap(
                (parameter) => parameter.defaultOrigins ?? [],
              ),
            ),
          );
          return defaultOrigins.length > 0 ? { defaultOrigins } : {};
        })(),
      };
    }),
    maySuspend: contracts.some((contract) => contract.maySuspend),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
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

const mergeProjectionPaths = (
  parameters: readonly CallableParameterBorrowContract[],
  key: "retainedPaths" | "returnedPaths",
): Partial<CallableParameterBorrowContract> => {
  const paths = Array.from(
    new Map(
      parameters
        .flatMap((parameter) => {
          const active =
            key === "retainedPaths"
              ? parameter.retained
              : parameter.returned;
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
