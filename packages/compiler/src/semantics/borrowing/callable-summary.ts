import { incrementCompilerPerfCounter } from "../../perf.js";
import type { SourceSpan, SymbolId } from "../ids.js";
import type {
  BorrowEndpointAccess,
  BorrowTypeComparison,
  CallableBorrowContract,
  CallableResultInvocation,
  CallableBorrowTransfer,
  CallableParameterBorrowContract,
  CheckedNamedBorrowContract,
  DefaultBorrowAccessOrigin,
  DefaultBorrowOrigin,
  PlaceProjection,
  ReturnedBorrowOrigin,
  ReturnedTypeMatchingOrigin,
  ScopedCallbackBorrowContract,
} from "./model.js";
import { borrowTypeConditionId, projectionPathCovers } from "./model.js";

export const CALLABLE_BORROW_SUMMARY_SCHEMA =
  "voyd.callable-borrow-summary" as const;
export const CALLABLE_BORROW_SUMMARY_VERSION = 4 as const;
const LEGACY_CALLABLE_BORROW_SUMMARY_VERSION = 1 as const;
const IDENTITY_GUARD_CALLABLE_BORROW_SUMMARY_VERSION = 2 as const;
const FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION = 3 as const;
const PRIVATE_SUMMARY_REGION_SCOPE = "voyd.summary.private";
const PRIVATE_SUMMARY_REGION_NAME = "storage";

export type PrivateSummaryPathRedaction = {
  index: number;
  token: string;
};

export const isPrivateSummaryRegionProjection = (
  projection: PlaceProjection | undefined,
): boolean =>
  projection?.kind === "region" &&
  projection.scope === PRIVATE_SUMMARY_REGION_SCOPE &&
  (projection.name === PRIVATE_SUMMARY_REGION_NAME ||
    projection.name.startsWith(`${PRIVATE_SUMMARY_REGION_NAME}:`));

export const redactPrivateSummaryPath = (
  path: readonly PlaceProjection[],
  redaction: PrivateSummaryPathRedaction | undefined,
): readonly PlaceProjection[] => {
  if (!redaction) {
    return path;
  }
  const privateStorageProjection = (): PlaceProjection => ({
    kind: "region",
    scope: PRIVATE_SUMMARY_REGION_SCOPE,
    name: `${PRIVATE_SUMMARY_REGION_NAME}:${redaction.token}`,
    disjoint: [],
  });
  const privatePath: PlaceProjection[] = [];
  let hasHiddenSegment = false;
  path.slice(redaction.index).forEach((projection) => {
    if (projection.kind !== "dereference") {
      hasHiddenSegment = true;
      return;
    }
    if (hasHiddenSegment) {
      privatePath.push(privateStorageProjection());
    }
    privatePath.push(projection);
    hasHiddenSegment = false;
  });
  if (hasHiddenSegment) {
    privatePath.push(privateStorageProjection());
  }
  return [...path.slice(0, redaction.index), ...privatePath];
};

export type CallableBorrowDispatchKind =
  | "ordinary"
  | "trait-declaration"
  | "trait-implementation";

export type CallableBorrowSummarySpan = {
  moduleId: string;
  start: number;
  end: number;
};

export type CallableBorrowSummarySource = {
  declaration: CallableBorrowSummarySpan;
  parameters: readonly CallableBorrowSummarySpan[];
};

export type PublicNamedBorrowContract = {
  scope: string;
  regions: readonly string[];
  disjoint: readonly (readonly [string, string])[];
  reads: readonly string[];
  mutates: readonly string[];
  returnsFrom: readonly string[];
};

export type CallableBorrowSummary = {
  schema: typeof CALLABLE_BORROW_SUMMARY_SCHEMA;
  version: typeof CALLABLE_BORROW_SUMMARY_VERSION;
  dispatch: CallableBorrowDispatchKind;
  contract: CallableBorrowContract;
  namedContract?: PublicNamedBorrowContract;
  source?: CallableBorrowSummarySource;
};

export type EncodedCallableBorrowSummary = {
  serialized: string;
  serializedBytes: number;
  summary: CallableBorrowSummary;
};

export type CallableBorrowSummarySerializationMode = {
  purpose: "public-export" | "trait-declaration-contract";
  dispatch: CallableBorrowDispatchKind;
  privacy: "public-redacted" | "unredacted";
  source: "included" | "omitted";
};

export type CallableBorrowSummarySerializationCache = {
  readonly entries: Map<SymbolId, Map<string, EncodedCallableBorrowSummary>>;
  readonly stats: {
    hits: number;
    misses: number;
  };
};

export const createCallableBorrowSummarySerializationCache =
  (): CallableBorrowSummarySerializationCache => ({
    entries: new Map(),
    stats: { hits: 0, misses: 0 },
  });

export const cachedCallableBorrowSummaryEncoding = ({
  cache,
  callable,
  mode,
  encode,
}: {
  cache: CallableBorrowSummarySerializationCache;
  callable: SymbolId;
  mode: CallableBorrowSummarySerializationMode;
  encode: () => EncodedCallableBorrowSummary;
}): EncodedCallableBorrowSummary => {
  const modeKey = JSON.stringify(mode);
  const cached = cache.entries.get(callable)?.get(modeKey);
  if (cached) {
    cache.stats.hits += 1;
    incrementCompilerPerfCounter("borrowing.summary.serializationCacheHit");
    return cached;
  }

  cache.stats.misses += 1;
  incrementCompilerPerfCounter("borrowing.summary.serializationCacheMiss");
  const encoded = encode();
  const modes =
    cache.entries.get(callable) ??
    new Map<string, EncodedCallableBorrowSummary>();
  modes.set(modeKey, encoded);
  cache.entries.set(callable, modes);
  return encoded;
};

export type CallableBorrowSummaryPrivacy = {
  privateParameterProjection: (
    parameter: number,
    path: readonly PlaceProjection[],
  ) => PrivateSummaryPathRedaction | undefined;
  privateResultProjection: (
    path: readonly PlaceProjection[],
  ) => PrivateSummaryPathRedaction | undefined;
  privateCallbackResultProjection: (
    parameter: number,
    source: readonly PlaceProjection[],
    path: readonly PlaceProjection[],
  ) => PrivateSummaryPathRedaction | undefined;
};

type WireProjectionV1 =
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "tuple"; readonly index: number }
  | {
      readonly kind: "index";
      readonly constant?: number;
      readonly stable: boolean;
    }
  | {
      readonly kind: "region";
      readonly scope: string;
      readonly name: string;
      readonly disjoint: readonly string[];
    }
  | { readonly kind: "discriminant" }
  | { readonly kind: "dereference" }
  | { readonly kind: "identity" };

type WireOriginV1 = {
  readonly source: readonly WireProjectionV1[];
  readonly result: readonly WireProjectionV1[];
  readonly endpointAccess?: BorrowEndpointAccess;
  readonly defaultNoBorrow?: true;
};

type WireTypeMatchingOriginV1 = WireOriginV1 & {
  readonly conditionId: string;
};

type WireTypeComparisonV1 = {
  readonly conditionId: string;
  readonly parameter: number;
  readonly sourcePath: readonly WireProjectionV1[];
  readonly resultPath: readonly WireProjectionV1[];
  readonly endpointAccess?: BorrowEndpointAccess;
};

type WireDefaultOriginV1 = {
  readonly parameter: number;
  readonly source: readonly WireProjectionV1[];
  readonly result: readonly WireProjectionV1[];
  readonly endpointAccess?: BorrowEndpointAccess;
};

type WireDefaultAccessOriginV1 = {
  readonly parameter: number;
  readonly path: readonly WireProjectionV1[];
};

type WireExternalReturnedOriginV1 = {
  readonly result: readonly WireProjectionV1[];
  readonly endpointAccess?: BorrowEndpointAccess;
  readonly fresh?: true;
};

type WireParameterContractV1 = {
  readonly access: "owned" | "shared" | "mutable";
  readonly readPaths?: readonly (readonly WireProjectionV1[])[];
  readonly writePaths?: readonly (readonly WireProjectionV1[])[];
  readonly runtimeCheckedWrites?: true;
  readonly retained: boolean;
  readonly retainedUnlessBorrowed?: true;
  readonly returned: boolean;
  readonly returnedAggregate?: true;
  readonly retainedPaths?: readonly (readonly WireProjectionV1[])[];
  readonly externalRetainedPaths?: readonly (readonly WireProjectionV1[])[];
  readonly borrowedRetainedPaths?: readonly (readonly WireProjectionV1[])[];
  readonly returnedPaths?: readonly (readonly WireProjectionV1[])[];
  readonly returnedOrigins?: readonly WireOriginV1[];
  readonly returnedSharedOrigins?: readonly WireOriginV1[];
  readonly returnedTypeMatchingOrigins?: readonly WireTypeMatchingOriginV1[];
  readonly accessIfResultTypeDiffers?: WireTypeComparisonV1;
  readonly invalidatedPaths?: readonly (readonly WireProjectionV1[])[];
  readonly defaultOrigins?: readonly WireDefaultOriginV1[];
  readonly defaultReadOrigins?: readonly WireDefaultAccessOriginV1[];
  readonly defaultWriteOrigins?: readonly WireDefaultAccessOriginV1[];
  readonly defaultExternalOrigins?: readonly WireExternalReturnedOriginV1[];
  readonly defaultExternalReturnedOrigins?: readonly WireExternalReturnedOriginV1[];
  readonly defaultExternalRead?: true;
  readonly defaultExternalWrite?: true;
  readonly defaultBorrowedResult?: "none";
  readonly defaultNoBorrowPaths?: readonly (readonly WireProjectionV1[])[];
};

type WireTransferV1 = {
  readonly sourceParameter: number;
  readonly destinationParameter: number;
  readonly sourcePath?: readonly WireProjectionV1[];
  readonly destinationPath?: readonly WireProjectionV1[];
  readonly sourceInvalidated?: true;
  readonly borrowsSource?: true;
  readonly conservative?: true;
};

type WireScopedCallbackV1 = {
  readonly callbackParameter: number;
  readonly callbackValueParameter: number;
  readonly access: "shared" | "mutable";
  readonly callbackPath?: readonly string[];
  readonly defaultCallbackBehavior?: "safe" | "escapes" | "unknown";
};

type WireCallableResultInvocationV4 = {
  readonly parameter: number;
  readonly source: readonly WireProjectionV1[];
  readonly callbackResult: readonly WireProjectionV1[];
  readonly callbackResultType?: {
    readonly moduleId: string;
    readonly symbol: number;
  };
  readonly result: readonly WireProjectionV1[];
};

type WireContractV1 = {
  readonly parameters: readonly WireParameterContractV1[];
  readonly maySuspend: boolean;
  readonly defaultIdentityGuardProtocol?: never;
  readonly borrowedResult?: "none" | "parameter" | "external";
  readonly externalReturnedOrigins?: readonly WireExternalReturnedOriginV1[];
  readonly externalRead?: true;
  readonly externalWrite?: true;
  readonly transfers?: readonly WireTransferV1[];
  readonly scopedCallbacks?: readonly WireScopedCallbackV1[];
};

type WireContractV2 = Omit<WireContractV1, "defaultIdentityGuardProtocol"> & {
  readonly defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
};

type WireContractV3 = WireContractV2 & {
  readonly freshResult?: true;
};

type WireContractV4 = WireContractV3 & {
  readonly callableResultInvocations?: readonly WireCallableResultInvocationV4[];
};

type WireContract =
  | WireContractV1
  | WireContractV2
  | WireContractV3
  | WireContractV4;

type WireNamedContractV1 = {
  readonly scope: string;
  readonly regions: readonly string[];
  readonly disjoint: readonly (readonly [string, string])[];
  readonly reads: readonly string[];
  readonly mutates: readonly string[];
  readonly returnsFrom: readonly string[];
};

type WireSummarySpanV1 = {
  readonly moduleId: string;
  readonly start: number;
  readonly end: number;
};

type WireSummarySourceV1 = {
  readonly declaration: WireSummarySpanV1;
  readonly parameters: readonly WireSummarySpanV1[];
};

type WireCallableBorrowSummaryV1 = {
  readonly schema: typeof CALLABLE_BORROW_SUMMARY_SCHEMA;
  readonly version: typeof LEGACY_CALLABLE_BORROW_SUMMARY_VERSION;
  readonly dispatch: CallableBorrowDispatchKind;
  readonly contract: WireContractV1;
  readonly namedContract?: WireNamedContractV1;
  readonly source?: WireSummarySourceV1;
};

type WireCallableBorrowSummaryV2 = {
  readonly schema: typeof CALLABLE_BORROW_SUMMARY_SCHEMA;
  readonly version: typeof IDENTITY_GUARD_CALLABLE_BORROW_SUMMARY_VERSION;
  readonly dispatch: CallableBorrowDispatchKind;
  readonly contract: WireContractV2;
  readonly namedContract?: WireNamedContractV1;
  readonly source?: WireSummarySourceV1;
};

type WireCallableBorrowSummaryV3 = {
  readonly schema: typeof CALLABLE_BORROW_SUMMARY_SCHEMA;
  readonly version: typeof FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION;
  readonly dispatch: CallableBorrowDispatchKind;
  readonly contract: WireContractV3;
  readonly namedContract?: WireNamedContractV1;
  readonly source?: WireSummarySourceV1;
};

type WireCallableBorrowSummaryV4 = {
  readonly schema: typeof CALLABLE_BORROW_SUMMARY_SCHEMA;
  readonly version: typeof CALLABLE_BORROW_SUMMARY_VERSION;
  readonly dispatch: CallableBorrowDispatchKind;
  readonly contract: WireContractV4;
  readonly namedContract?: WireNamedContractV1;
  readonly source?: WireSummarySourceV1;
};

type WireCallableBorrowSummary =
  | WireCallableBorrowSummaryV1
  | WireCallableBorrowSummaryV2
  | WireCallableBorrowSummaryV3
  | WireCallableBorrowSummaryV4;

export const encodeCallableBorrowSummary = ({
  contract,
  namedContract,
  dispatchHint,
  publicAbstraction = false,
  publicPrivacy,
  source,
}: {
  contract: CallableBorrowContract;
  namedContract?: CheckedNamedBorrowContract;
  dispatchHint?: Exclude<CallableBorrowDispatchKind, "ordinary">;
  publicAbstraction?: boolean;
  publicPrivacy?: CallableBorrowSummaryPrivacy;
  source?: CallableBorrowSummarySource;
}): EncodedCallableBorrowSummary => {
  const dispatch: CallableBorrowDispatchKind =
    dispatchHint ??
    (namedContract?.implementation !== undefined
      ? "trait-implementation"
      : namedContract
        ? "trait-declaration"
        : "ordinary");
  const publicContract =
    dispatch === "trait-implementation"
      ? contract.dynamicDispatch
        ? conservativePublicContract(
            contract.dynamicDispatch,
            true,
            namedContract?.scope,
          )
        : conservativePublicContract(contract)
      : (dispatch === "trait-declaration" && !namedContract) ||
          publicAbstraction
        ? conservativePublicContract(contract)
        : publicPrivacy
          ? redactPrivateContractPaths(contract, publicPrivacy)
          : contract;
  const wire: WireCallableBorrowSummaryV4 = {
    schema: CALLABLE_BORROW_SUMMARY_SCHEMA,
    version: CALLABLE_BORROW_SUMMARY_VERSION,
    dispatch,
    contract: namedContract
      ? toWireContract(publicContract)
      : stripWireRegionDisjointness(toWireContract(publicContract)),
    ...(namedContract
      ? { namedContract: toWireNamedContract(namedContract) }
      : {}),
    ...(source ? { source: toWireSource(source) } : {}),
  };
  const serialized = canonicalJson(wire);
  const serializedBytes = callableBorrowSummarySize(serialized);
  incrementCompilerPerfCounter("borrowing.summary.serializedCount");
  incrementCompilerPerfCounter(
    "borrowing.summary.serializedBytes",
    serializedBytes,
  );
  return {
    serialized,
    serializedBytes,
    summary: {
      schema: CALLABLE_BORROW_SUMMARY_SCHEMA,
      version: CALLABLE_BORROW_SUMMARY_VERSION,
      dispatch,
      contract: fromWireContract(wire.contract),
      ...(wire.namedContract
        ? { namedContract: fromWireNamedContract(wire.namedContract) }
        : {}),
      ...(wire.source ? { source: fromWireSource(wire.source) } : {}),
    },
  };
};

export const serializeCallableBorrowSummary = (
  options: Parameters<typeof encodeCallableBorrowSummary>[0],
): string => encodeCallableBorrowSummary(options).serialized;

const stripWireRegionDisjointness = (
  contract: WireContractV4,
): WireContractV4 => {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        value.kind === "region" && key === "disjoint" ? [] : strip(entry),
      ]),
    );
  };
  return strip(contract) as WireContractV4;
};

export const deserializeCallableBorrowSummary = (
  serialized: string,
): CallableBorrowSummary => {
  incrementCompilerPerfCounter("borrowing.summary.deserializedCount");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalidSummary("summary is not valid JSON");
  }
  if (!isWireSummary(value)) {
    throw invalidSummary("summary does not match the V1 schema");
  }
  return {
    schema: CALLABLE_BORROW_SUMMARY_SCHEMA,
    version: CALLABLE_BORROW_SUMMARY_VERSION,
    dispatch: value.dispatch,
    contract: fromWireContract(value.contract),
    ...(value.namedContract
      ? { namedContract: fromWireNamedContract(value.namedContract) }
      : {}),
    ...(value.source ? { source: fromWireSource(value.source) } : {}),
  };
};

export const callableBorrowSummarySize = (serialized: string): number =>
  new TextEncoder().encode(serialized).byteLength;

export const summarySpanToSourceSpan = (
  span: CallableBorrowSummarySpan,
): SourceSpan => ({
  file: span.moduleId,
  start: span.start,
  end: span.end,
});

const toWireContract = (contract: CallableBorrowContract): WireContractV4 => ({
  parameters: contract.parameters.map(toWireParameter),
  maySuspend: contract.maySuspend,
  ...(contract.freshResult ? { freshResult: true } : {}),
  ...(contract.defaultIdentityGuardProtocol
    ? {
        defaultIdentityGuardProtocol: contract.defaultIdentityGuardProtocol,
      }
    : {}),
  ...(contract.borrowedResult
    ? { borrowedResult: contract.borrowedResult }
    : {}),
  ...(contract.externalReturnedOrigins
    ? {
        externalReturnedOrigins: contract.externalReturnedOrigins.map(
          (origin) => ({
            result: toWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          }),
        ),
      }
    : {}),
  ...(contract.externalRead ? { externalRead: true } : {}),
  ...(contract.externalWrite ? { externalWrite: true } : {}),
  ...(contract.transfers
    ? { transfers: contract.transfers.map(toWireTransfer) }
    : {}),
  ...(contract.scopedCallbacks
    ? { scopedCallbacks: contract.scopedCallbacks.map(toWireScopedCallback) }
    : {}),
  ...(contract.callableResultInvocations
    ? {
        callableResultInvocations: contract.callableResultInvocations.map(
          toWireCallableResultInvocation,
        ),
      }
    : {}),
});

const toWireParameter = (
  parameter: CallableParameterBorrowContract,
): WireParameterContractV1 => ({
  access: parameter.access,
  ...(parameter.readPaths
    ? { readPaths: parameter.readPaths.map(toWirePath) }
    : {}),
  ...(parameter.writePaths
    ? { writePaths: parameter.writePaths.map(toWirePath) }
    : {}),
  ...(parameter.runtimeCheckedWrites ? { runtimeCheckedWrites: true } : {}),
  retained: parameter.retained,
  ...(parameter.retainedUnlessBorrowed ? { retainedUnlessBorrowed: true } : {}),
  returned: parameter.returned,
  ...(parameter.returnedAggregate ? { returnedAggregate: true } : {}),
  ...(parameter.retainedPaths
    ? { retainedPaths: parameter.retainedPaths.map(toWirePath) }
    : {}),
  ...(parameter.externalRetainedPaths
    ? {
        externalRetainedPaths: parameter.externalRetainedPaths.map(toWirePath),
      }
    : {}),
  ...(parameter.borrowedRetainedPaths
    ? {
        borrowedRetainedPaths: parameter.borrowedRetainedPaths.map(toWirePath),
      }
    : {}),
  ...(parameter.returnedPaths
    ? { returnedPaths: parameter.returnedPaths.map(toWirePath) }
    : {}),
  ...(parameter.returnedOrigins
    ? { returnedOrigins: parameter.returnedOrigins.map(toWireOrigin) }
    : {}),
  ...(parameter.returnedSharedOrigins
    ? {
        returnedSharedOrigins:
          parameter.returnedSharedOrigins.map(toWireOrigin),
      }
    : {}),
  ...(parameter.returnedTypeMatchingOrigins
    ? {
        returnedTypeMatchingOrigins: parameter.returnedTypeMatchingOrigins.map(
          toWireTypeMatchingOrigin,
        ),
      }
    : {}),
  ...(parameter.accessIfResultTypeDiffers
    ? {
        accessIfResultTypeDiffers: toWireTypeComparison(
          parameter.accessIfResultTypeDiffers,
        ),
      }
    : {}),
  ...(parameter.invalidatedPaths
    ? { invalidatedPaths: parameter.invalidatedPaths.map(toWirePath) }
    : {}),
  ...(parameter.defaultOrigins
    ? { defaultOrigins: parameter.defaultOrigins.map(toWireDefaultOrigin) }
    : {}),
  ...(parameter.defaultReadOrigins
    ? {
        defaultReadOrigins: parameter.defaultReadOrigins.map(
          toWireDefaultAccessOrigin,
        ),
      }
    : {}),
  ...(parameter.defaultWriteOrigins
    ? {
        defaultWriteOrigins: parameter.defaultWriteOrigins.map(
          toWireDefaultAccessOrigin,
        ),
      }
    : {}),
  ...(parameter.defaultExternalOrigins
    ? {
        defaultExternalOrigins: parameter.defaultExternalOrigins.map(
          (origin) => ({
            result: toWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          }),
        ),
      }
    : {}),
  ...(parameter.defaultExternalReturnedOrigins
    ? {
        defaultExternalReturnedOrigins:
          parameter.defaultExternalReturnedOrigins.map((origin) => ({
            result: toWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          })),
      }
    : {}),
  ...(parameter.defaultExternalRead ? { defaultExternalRead: true } : {}),
  ...(parameter.defaultExternalWrite ? { defaultExternalWrite: true } : {}),
  ...(parameter.defaultBorrowedResult
    ? { defaultBorrowedResult: parameter.defaultBorrowedResult }
    : {}),
  ...(parameter.defaultNoBorrowPaths
    ? {
        defaultNoBorrowPaths: parameter.defaultNoBorrowPaths.map(toWirePath),
      }
    : {}),
});

const toWirePath = (
  path: readonly PlaceProjection[],
): readonly WireProjectionV1[] => path.map(toWireProjection);

const toWireProjection = (projection: PlaceProjection): WireProjectionV1 => {
  switch (projection.kind) {
    case "field":
      return { kind: "field", name: projection.name };
    case "tuple":
      return { kind: "tuple", index: projection.index };
    case "index":
      return {
        kind: "index",
        stable: projection.stable,
        ...(projection.constant !== undefined
          ? { constant: projection.constant }
          : {}),
      };
    case "region":
      return {
        kind: "region",
        scope: projection.scope,
        name: projection.name,
        disjoint: [...projection.disjoint],
      };
    case "discriminant":
    case "dereference":
    case "identity":
      return { kind: projection.kind };
  }
};

const toWireOrigin = (origin: ReturnedBorrowOrigin): WireOriginV1 => ({
  source: toWirePath(origin.source),
  result: toWirePath(origin.result),
  ...(origin.endpointAccess ? { endpointAccess: origin.endpointAccess } : {}),
  ...(origin.defaultNoBorrow ? { defaultNoBorrow: true } : {}),
});

const toWireTypeMatchingOrigin = (
  origin: ReturnedTypeMatchingOrigin,
): WireTypeMatchingOriginV1 => ({
  ...toWireOrigin(origin),
  conditionId: origin.conditionId,
});

const toWireTypeComparison = (
  comparison: BorrowTypeComparison,
): WireTypeComparisonV1 => ({
  conditionId: comparison.conditionId,
  parameter: comparison.parameter,
  sourcePath: toWirePath(comparison.sourcePath),
  resultPath: toWirePath(comparison.resultPath),
  ...(comparison.endpointAccess
    ? { endpointAccess: comparison.endpointAccess }
    : {}),
});

const toWireDefaultOrigin = (
  origin: DefaultBorrowOrigin,
): WireDefaultOriginV1 => ({
  parameter: origin.parameter,
  source: toWirePath(origin.source),
  result: toWirePath(origin.result),
  ...(origin.endpointAccess ? { endpointAccess: origin.endpointAccess } : {}),
});

const toWireDefaultAccessOrigin = (
  origin: DefaultBorrowAccessOrigin,
): WireDefaultAccessOriginV1 => ({
  parameter: origin.parameter,
  path: toWirePath(origin.path),
});

const toWireTransfer = (transfer: CallableBorrowTransfer): WireTransferV1 => ({
  sourceParameter: transfer.sourceParameter,
  destinationParameter: transfer.destinationParameter,
  ...(transfer.sourcePath
    ? { sourcePath: toWirePath(transfer.sourcePath) }
    : {}),
  ...(transfer.destinationPath
    ? { destinationPath: toWirePath(transfer.destinationPath) }
    : {}),
  ...(transfer.sourceInvalidated ? { sourceInvalidated: true } : {}),
  ...(transfer.borrowsSource ? { borrowsSource: true } : {}),
  ...(transfer.conservative ? { conservative: true } : {}),
});

const toWireScopedCallback = (
  callback: ScopedCallbackBorrowContract,
): WireScopedCallbackV1 => ({
  callbackParameter: callback.callbackParameter,
  callbackValueParameter: callback.callbackValueParameter,
  access: callback.access,
  ...(callback.callbackPath
    ? { callbackPath: [...callback.callbackPath] }
    : {}),
  ...(callback.defaultCallbackBehavior
    ? { defaultCallbackBehavior: callback.defaultCallbackBehavior }
    : {}),
});

const toWireCallableResultInvocation = (
  invocation: CallableResultInvocation,
): WireCallableResultInvocationV4 => ({
  parameter: invocation.parameter,
  source: toWirePath(invocation.source),
  callbackResult: toWirePath(invocation.callbackResult),
  ...(invocation.callbackResultType
    ? { callbackResultType: { ...invocation.callbackResultType } }
    : {}),
  result: toWirePath(invocation.result),
});

const toWireNamedContract = (
  contract: CheckedNamedBorrowContract,
): WireNamedContractV1 => ({
  scope: contract.scope,
  regions: contract.regions.map((region) => region.name),
  disjoint: contract.disjoint.map(([left, right]) => [left, right]),
  reads: [...contract.reads],
  mutates: [...contract.mutates],
  returnsFrom: [...contract.returnsFrom],
});

const toWireSource = (
  source: CallableBorrowSummarySource,
): WireSummarySourceV1 => ({
  declaration: { ...source.declaration },
  parameters: source.parameters.map((parameter) => ({ ...parameter })),
});

const fromWireContract = (contract: WireContract): CallableBorrowContract => ({
  parameters: contract.parameters.map(fromWireParameter),
  maySuspend: contract.maySuspend,
  ...("freshResult" in contract && contract.freshResult
    ? { freshResult: true }
    : {}),
  ...(contract.defaultIdentityGuardProtocol
    ? {
        defaultIdentityGuardProtocol: contract.defaultIdentityGuardProtocol,
      }
    : {}),
  ...(contract.borrowedResult
    ? { borrowedResult: contract.borrowedResult }
    : {}),
  ...(contract.externalReturnedOrigins
    ? {
        externalReturnedOrigins: contract.externalReturnedOrigins.map(
          (origin) => ({
            result: fromWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          }),
        ),
      }
    : {}),
  ...(contract.externalRead ? { externalRead: true } : {}),
  ...(contract.externalWrite ? { externalWrite: true } : {}),
  ...(contract.transfers
    ? { transfers: contract.transfers.map(fromWireTransfer) }
    : {}),
  ...(contract.scopedCallbacks
    ? {
        scopedCallbacks: contract.scopedCallbacks.map(fromWireScopedCallback),
      }
    : {}),
  ...("callableResultInvocations" in contract &&
  contract.callableResultInvocations
    ? {
        callableResultInvocations: contract.callableResultInvocations.map(
          fromWireCallableResultInvocation,
        ),
      }
    : {}),
});

const fromWireParameter = (
  parameter: WireParameterContractV1,
): CallableParameterBorrowContract => ({
  access: parameter.access,
  ...(parameter.readPaths
    ? { readPaths: parameter.readPaths.map(fromWirePath) }
    : {}),
  ...(parameter.writePaths
    ? { writePaths: parameter.writePaths.map(fromWirePath) }
    : {}),
  ...(parameter.runtimeCheckedWrites ? { runtimeCheckedWrites: true } : {}),
  retained: parameter.retained,
  ...(parameter.retainedUnlessBorrowed ? { retainedUnlessBorrowed: true } : {}),
  returned: parameter.returned,
  ...(parameter.returnedAggregate ? { returnedAggregate: true } : {}),
  ...(parameter.retainedPaths
    ? { retainedPaths: parameter.retainedPaths.map(fromWirePath) }
    : {}),
  ...(parameter.externalRetainedPaths
    ? {
        externalRetainedPaths:
          parameter.externalRetainedPaths.map(fromWirePath),
      }
    : {}),
  ...(parameter.borrowedRetainedPaths
    ? {
        borrowedRetainedPaths:
          parameter.borrowedRetainedPaths.map(fromWirePath),
      }
    : {}),
  ...(parameter.returnedPaths
    ? { returnedPaths: parameter.returnedPaths.map(fromWirePath) }
    : {}),
  ...(parameter.returnedOrigins
    ? { returnedOrigins: parameter.returnedOrigins.map(fromWireOrigin) }
    : {}),
  ...(parameter.returnedSharedOrigins
    ? {
        returnedSharedOrigins:
          parameter.returnedSharedOrigins.map(fromWireOrigin),
      }
    : {}),
  ...(parameter.returnedTypeMatchingOrigins
    ? {
        returnedTypeMatchingOrigins: parameter.returnedTypeMatchingOrigins.map(
          fromWireTypeMatchingOrigin,
        ),
      }
    : {}),
  ...(parameter.accessIfResultTypeDiffers
    ? {
        accessIfResultTypeDiffers: fromWireTypeComparison(
          parameter.accessIfResultTypeDiffers,
        ),
      }
    : {}),
  ...(parameter.invalidatedPaths
    ? { invalidatedPaths: parameter.invalidatedPaths.map(fromWirePath) }
    : {}),
  ...(parameter.defaultOrigins
    ? { defaultOrigins: parameter.defaultOrigins.map(fromWireDefaultOrigin) }
    : {}),
  ...(parameter.defaultReadOrigins
    ? {
        defaultReadOrigins: parameter.defaultReadOrigins.map(
          fromWireDefaultAccessOrigin,
        ),
      }
    : {}),
  ...(parameter.defaultWriteOrigins
    ? {
        defaultWriteOrigins: parameter.defaultWriteOrigins.map(
          fromWireDefaultAccessOrigin,
        ),
      }
    : {}),
  ...(parameter.defaultExternalOrigins
    ? {
        defaultExternalOrigins: parameter.defaultExternalOrigins.map(
          (origin) => ({
            result: fromWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          }),
        ),
      }
    : {}),
  ...(parameter.defaultExternalReturnedOrigins
    ? {
        defaultExternalReturnedOrigins:
          parameter.defaultExternalReturnedOrigins.map((origin) => ({
            result: fromWirePath(origin.result),
            ...(origin.endpointAccess
              ? { endpointAccess: origin.endpointAccess }
              : {}),
            ...(origin.fresh ? { fresh: true } : {}),
          })),
      }
    : {}),
  ...(parameter.defaultExternalRead ? { defaultExternalRead: true } : {}),
  ...(parameter.defaultExternalWrite ? { defaultExternalWrite: true } : {}),
  ...(parameter.defaultBorrowedResult
    ? { defaultBorrowedResult: parameter.defaultBorrowedResult }
    : {}),
  ...(parameter.defaultNoBorrowPaths
    ? {
        defaultNoBorrowPaths: parameter.defaultNoBorrowPaths.map(fromWirePath),
      }
    : {}),
});

const fromWirePath = (
  path: readonly WireProjectionV1[],
): readonly PlaceProjection[] => path.map(fromWireProjection);

const fromWireProjection = (projection: WireProjectionV1): PlaceProjection => {
  switch (projection.kind) {
    case "field":
      return { kind: "field", name: projection.name };
    case "tuple":
      return { kind: "tuple", index: projection.index };
    case "index":
      return {
        kind: "index",
        stable: projection.stable,
        ...(projection.constant !== undefined
          ? { constant: projection.constant }
          : {}),
      };
    case "region":
      return {
        kind: "region",
        scope: projection.scope,
        name: projection.name,
        disjoint: [...projection.disjoint],
      };
    case "discriminant":
    case "dereference":
    case "identity":
      return { kind: projection.kind };
  }
};

const fromWireOrigin = (origin: WireOriginV1): ReturnedBorrowOrigin => ({
  source: fromWirePath(origin.source),
  result: fromWirePath(origin.result),
  ...(origin.endpointAccess ? { endpointAccess: origin.endpointAccess } : {}),
  ...(origin.defaultNoBorrow ? { defaultNoBorrow: true } : {}),
});

const fromWireTypeMatchingOrigin = (
  origin: WireTypeMatchingOriginV1,
): ReturnedTypeMatchingOrigin => ({
  ...fromWireOrigin(origin),
  conditionId: origin.conditionId,
});

const fromWireTypeComparison = (
  comparison: WireTypeComparisonV1,
): BorrowTypeComparison => ({
  conditionId: comparison.conditionId,
  parameter: comparison.parameter,
  sourcePath: fromWirePath(comparison.sourcePath),
  resultPath: fromWirePath(comparison.resultPath),
  ...(comparison.endpointAccess
    ? { endpointAccess: comparison.endpointAccess }
    : {}),
});

const fromWireDefaultOrigin = (
  origin: WireDefaultOriginV1,
): DefaultBorrowOrigin => ({
  parameter: origin.parameter,
  source: fromWirePath(origin.source),
  result: fromWirePath(origin.result),
  ...(origin.endpointAccess ? { endpointAccess: origin.endpointAccess } : {}),
});

const fromWireDefaultAccessOrigin = (
  origin: WireDefaultAccessOriginV1,
): DefaultBorrowAccessOrigin => ({
  parameter: origin.parameter,
  path: fromWirePath(origin.path),
});

const fromWireTransfer = (
  transfer: WireTransferV1,
): CallableBorrowTransfer => ({
  sourceParameter: transfer.sourceParameter,
  destinationParameter: transfer.destinationParameter,
  ...(transfer.sourcePath
    ? { sourcePath: fromWirePath(transfer.sourcePath) }
    : {}),
  ...(transfer.destinationPath
    ? { destinationPath: fromWirePath(transfer.destinationPath) }
    : {}),
  ...(transfer.sourceInvalidated ? { sourceInvalidated: true } : {}),
  ...(transfer.borrowsSource ? { borrowsSource: true } : {}),
  ...(transfer.conservative ? { conservative: true } : {}),
});

const fromWireScopedCallback = (
  callback: WireScopedCallbackV1,
): ScopedCallbackBorrowContract => ({
  callbackParameter: callback.callbackParameter,
  callbackValueParameter: callback.callbackValueParameter,
  access: callback.access,
  ...(callback.callbackPath
    ? { callbackPath: [...callback.callbackPath] }
    : {}),
  ...(callback.defaultCallbackBehavior
    ? { defaultCallbackBehavior: callback.defaultCallbackBehavior }
    : {}),
});

const fromWireCallableResultInvocation = (
  invocation: WireCallableResultInvocationV4,
): CallableResultInvocation => ({
  parameter: invocation.parameter,
  source: fromWirePath(invocation.source),
  callbackResult: fromWirePath(invocation.callbackResult),
  ...(invocation.callbackResultType
    ? { callbackResultType: { ...invocation.callbackResultType } }
    : {}),
  result: fromWirePath(invocation.result),
});

const fromWireNamedContract = (
  contract: WireNamedContractV1,
): PublicNamedBorrowContract => ({
  scope: contract.scope,
  regions: [...contract.regions],
  disjoint: contract.disjoint.map(([left, right]) => [left, right]),
  reads: [...contract.reads],
  mutates: [...contract.mutates],
  returnsFrom: [...contract.returnsFrom],
});

const fromWireSource = (
  source: WireSummarySourceV1,
): CallableBorrowSummarySource => ({
  declaration: { ...source.declaration },
  parameters: source.parameters.map((parameter) => ({ ...parameter })),
});

const redactPrivateContractPaths = (
  contract: CallableBorrowContract,
  privacy: CallableBorrowSummaryPrivacy,
): CallableBorrowContract => {
  const parameterPath = (
    parameter: number,
    path: readonly PlaceProjection[],
  ): readonly PlaceProjection[] =>
    redactPrivateSummaryPath(
      path,
      privacy.privateParameterProjection(parameter, path),
    );
  const resultPath = (
    path: readonly PlaceProjection[],
  ): readonly PlaceProjection[] =>
    redactPrivateSummaryPath(path, privacy.privateResultProjection(path));
  const parameterPaths = (
    parameter: number,
    paths: readonly (readonly PlaceProjection[])[] | undefined,
  ): readonly (readonly PlaceProjection[])[] | undefined =>
    paths?.map((path) => parameterPath(parameter, path));
  const returnedOrigin = (
    parameter: number,
    origin: ReturnedBorrowOrigin,
  ): ReturnedBorrowOrigin => ({
    ...origin,
    source: parameterPath(parameter, origin.source),
    result: resultPath(origin.result),
  });
  const externalOrigin = (
    origin: NonNullable<
      CallableBorrowContract["externalReturnedOrigins"]
    >[number],
  ) => ({
    ...origin,
    result: resultPath(origin.result),
  });
  const redact = (current: CallableBorrowContract): CallableBorrowContract => ({
    ...current,
    parameters: current.parameters.map((parameter, index) => ({
      ...parameter,
      ...(parameter.readPaths
        ? { readPaths: parameterPaths(index, parameter.readPaths) }
        : {}),
      ...(parameter.writePaths
        ? { writePaths: parameterPaths(index, parameter.writePaths) }
        : {}),
      ...(parameter.retainedPaths
        ? { retainedPaths: parameterPaths(index, parameter.retainedPaths) }
        : {}),
      ...(parameter.externalRetainedPaths
        ? {
            externalRetainedPaths: parameterPaths(
              index,
              parameter.externalRetainedPaths,
            ),
          }
        : {}),
      ...(parameter.borrowedRetainedPaths
        ? {
            borrowedRetainedPaths: parameterPaths(
              index,
              parameter.borrowedRetainedPaths,
            ),
          }
        : {}),
      ...(parameter.returnedPaths
        ? {
            returnedPaths: parameterPaths(index, parameter.returnedPaths),
          }
        : {}),
      ...(parameter.returnedOrigins
        ? {
            returnedOrigins: parameter.returnedOrigins.map((origin) =>
              returnedOrigin(index, origin),
            ),
          }
        : {}),
      ...(parameter.returnedSharedOrigins
        ? {
            returnedSharedOrigins: parameter.returnedSharedOrigins.map(
              (origin) => ({
                ...returnedOrigin(index, origin),
                ...(parameter.defaultBorrowedResult === "none" ||
                parameter.defaultNoBorrowPaths?.some((path) =>
                  projectionPathCovers(path, origin.source),
                ) === true
                  ? { defaultNoBorrow: true as const }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(parameter.returnedTypeMatchingOrigins
        ? {
            returnedTypeMatchingOrigins:
              parameter.returnedTypeMatchingOrigins.map((origin) => {
                const source = parameterPath(index, origin.source);
                const result = resultPath(origin.result);
                const endpointAccess = origin.endpointAccess ?? "inline";
                return {
                  ...origin,
                  source,
                  result,
                  conditionId: borrowTypeConditionId({
                    parameter: index,
                    sourcePath: source,
                    resultPath: result,
                    endpointAccess,
                  }),
                };
              }),
          }
        : {}),
      ...(parameter.accessIfResultTypeDiffers
        ? {
            accessIfResultTypeDiffers: (() => {
              const comparison = parameter.accessIfResultTypeDiffers;
              const sourcePath = parameterPath(
                comparison.parameter,
                comparison.sourcePath,
              );
              const comparisonResultPath = resultPath(comparison.resultPath);
              const endpointAccess = comparison.endpointAccess ?? "inline";
              return {
                ...comparison,
                sourcePath,
                resultPath: comparisonResultPath,
                conditionId: borrowTypeConditionId({
                  parameter: comparison.parameter,
                  sourcePath,
                  resultPath: comparisonResultPath,
                  endpointAccess,
                }),
              };
            })(),
          }
        : {}),
      ...(parameter.invalidatedPaths
        ? {
            invalidatedPaths: parameterPaths(index, parameter.invalidatedPaths),
          }
        : {}),
      ...(parameter.defaultOrigins
        ? {
            defaultOrigins: parameter.defaultOrigins.map((origin) => ({
              ...origin,
              source: parameterPath(origin.parameter, origin.source),
              result: parameterPath(index, origin.result),
            })),
          }
        : {}),
      ...(parameter.defaultReadOrigins
        ? {
            defaultReadOrigins: parameter.defaultReadOrigins.map((origin) => ({
              ...origin,
              path: parameterPath(origin.parameter, origin.path),
            })),
          }
        : {}),
      ...(parameter.defaultWriteOrigins
        ? {
            defaultWriteOrigins: parameter.defaultWriteOrigins.map(
              (origin) => ({
                ...origin,
                path: parameterPath(origin.parameter, origin.path),
              }),
            ),
          }
        : {}),
      ...(parameter.defaultExternalOrigins
        ? {
            defaultExternalOrigins: parameter.defaultExternalOrigins.map(
              (origin) => ({
                ...origin,
                result: parameterPath(index, origin.result),
              }),
            ),
          }
        : {}),
      ...(parameter.defaultExternalReturnedOrigins
        ? {
            defaultExternalReturnedOrigins:
              parameter.defaultExternalReturnedOrigins.map((origin) => ({
                ...origin,
                result: parameterPath(index, origin.result),
              })),
          }
        : {}),
      ...(parameter.defaultNoBorrowPaths
        ? parameter.defaultNoBorrowPaths.every(
            (path) =>
              privacy.privateParameterProjection(index, path) === undefined,
          )
          ? { defaultNoBorrowPaths: parameter.defaultNoBorrowPaths }
          : { defaultNoBorrowPaths: undefined }
        : {}),
    })),
    ...(current.externalReturnedOrigins
      ? {
          externalReturnedOrigins:
            current.externalReturnedOrigins.map(externalOrigin),
        }
      : {}),
    ...(current.transfers
      ? {
          transfers: current.transfers.map((transfer) => ({
            ...transfer,
            ...(transfer.sourcePath
              ? {
                  sourcePath: parameterPath(
                    transfer.sourceParameter,
                    transfer.sourcePath,
                  ),
                }
              : {}),
            ...(transfer.destinationPath
              ? {
                  destinationPath: parameterPath(
                    transfer.destinationParameter,
                    transfer.destinationPath,
                  ),
                }
              : {}),
          })),
        }
      : {}),
    ...(current.scopedCallbacks
      ? {
          scopedCallbacks: current.scopedCallbacks.map((callback) => {
            if (!callback.callbackPath) {
              return callback;
            }
            const path = parameterPath(
              callback.callbackParameter,
              callback.callbackPath.map((name) => ({
                kind: "field" as const,
                name,
              })),
            );
            return path.every(
              (
                projection,
              ): projection is Extract<PlaceProjection, { kind: "field" }> =>
                projection.kind === "field",
            )
              ? {
                  ...callback,
                  callbackPath: path.map((projection) => projection.name),
                }
              : (({ callbackPath: _callbackPath, ...publicCallback }) =>
                  publicCallback)(callback);
          }),
        }
      : {}),
    ...(current.callableResultInvocations
      ? {
          callableResultInvocations: current.callableResultInvocations.map(
            (invocation) => ({
              ...invocation,
              source: parameterPath(invocation.parameter, invocation.source),
              callbackResult: redactPrivateSummaryPath(
                invocation.callbackResult,
                privacy.privateCallbackResultProjection(
                  invocation.parameter,
                  invocation.source,
                  invocation.callbackResult,
                ),
              ),
              result: resultPath(invocation.result),
            }),
          ),
        }
      : {}),
    ...(current.dynamicDispatch
      ? { dynamicDispatch: redact(current.dynamicDispatch) }
      : {}),
  });
  return redact(contract);
};

const conservativePublicContract = (
  contract: CallableBorrowContract,
  preserveAbstractRegions = false,
  trustedRegionScope?: string,
): CallableBorrowContract => {
  const privateStorageProjection = (): PlaceProjection => ({
    kind: "region",
    scope: PRIVATE_SUMMARY_REGION_SCOPE,
    name: PRIVATE_SUMMARY_REGION_NAME,
    disjoint: [],
  });
  const privatePath = (
    path: readonly PlaceProjection[],
  ): readonly PlaceProjection[] => {
    const result: PlaceProjection[] = [];
    let hasHiddenSegment = false;
    path.forEach((projection) => {
      if (projection.kind !== "dereference") {
        hasHiddenSegment = true;
        return;
      }
      if (hasHiddenSegment) {
        result.push(privateStorageProjection());
      }
      result.push(projection);
      hasHiddenSegment = false;
    });
    if (hasHiddenSegment) {
      result.push(privateStorageProjection());
    }
    return result;
  };
  const publicPath = (
    path: readonly PlaceProjection[],
  ): readonly PlaceProjection[] => {
    if (!preserveAbstractRegions) {
      return privatePath(path);
    }
    const regionIndex = path.findIndex(
      (projection) =>
        projection.kind === "region" &&
        (trustedRegionScope === undefined ||
          projection.scope === trustedRegionScope),
    );
    if (regionIndex < 0) {
      return privatePath(path);
    }
    let end = regionIndex + 1;
    while (
      path[end]?.kind === "dereference" ||
      path[end]?.kind === "identity"
    ) {
      end += 1;
    }
    return path.slice(0, end);
  };
  const publicPaths = (
    paths: readonly (readonly PlaceProjection[])[],
  ): readonly (readonly PlaceProjection[])[] =>
    Array.from(
      new Map(
        paths.map((path) => {
          const abstract = publicPath(path);
          return [JSON.stringify(abstract), abstract] as const;
        }),
      ).values(),
    );
  const publicExternalOrigins = (
    origins:
      | CallableParameterBorrowContract["defaultExternalOrigins"]
      | undefined,
  ): NonNullable<CallableParameterBorrowContract["defaultExternalOrigins"]> =>
    Array.from(
      new Set(
        origins?.map((origin) =>
          JSON.stringify([
            publicPath(origin.result),
            origin.endpointAccess ?? "inline",
            origin.fresh ?? false,
          ]),
        ) ?? [],
      ),
      (serialized) => {
        const [result, endpointAccess, fresh] = JSON.parse(serialized) as [
          readonly PlaceProjection[],
          "inline" | "dereferenced",
          boolean,
        ];
        return {
          result,
          endpointAccess,
          ...(fresh ? { fresh: true as const } : {}),
        };
      },
    );
  return {
    parameters: contract.parameters.map((parameter, parameterIndex) => {
      const defaultContainsNoBorrowAt = (
        source: readonly PlaceProjection[],
      ): boolean =>
        parameter.defaultBorrowedResult === "none" ||
        parameter.defaultNoBorrowPaths?.some((path) =>
          projectionPathCovers(path, source),
        ) === true;
      const publicReturnedOrigin = (
        origin: ReturnedBorrowOrigin,
        preserveDefaultNoBorrow: boolean,
      ): ReturnedBorrowOrigin => ({
        source: publicPath(origin.source),
        result: publicPath(origin.result),
        endpointAccess: origin.endpointAccess ?? "inline",
        ...(preserveDefaultNoBorrow &&
        (origin.defaultNoBorrow || defaultContainsNoBorrowAt(origin.source))
          ? { defaultNoBorrow: true as const }
          : {}),
      });
      const returnedOrigins = Array.from(
        new Map(
          [
            ...(parameter.returnedOrigins ?? []),
            ...(parameter.returnedSharedOrigins ?? []),
          ].map((origin) => {
            const abstract = publicReturnedOrigin(origin, false);
            return [JSON.stringify(abstract), abstract] as const;
          }),
        ).values(),
      );
      if (parameter.returned && returnedOrigins.length === 0) {
        returnedOrigins.push({
          source: [],
          result: [],
          endpointAccess: "inline",
        });
      }
      const returnedSharedOrigins = Array.from(
        new Map(
          (parameter.returnedSharedOrigins ?? []).map((origin) => {
            const abstract = publicReturnedOrigin(origin, true);
            return [JSON.stringify(abstract), abstract] as const;
          }),
        ).values(),
      );
      const returnedAggregate =
        parameter.returnedAggregate === true ||
        ((parameter.returnedOrigins?.length ?? 0) > 0 &&
          parameter.returnedOrigins?.every(
            (origin) => origin.result.length > 0,
          ) === true);
      const returnedTypeMatchingOrigins = preserveAbstractRegions
        ? parameter.returnedTypeMatchingOrigins?.map((origin) => {
            const source = publicPath(origin.source);
            const result = publicPath(origin.result);
            const endpointAccess = origin.endpointAccess ?? "inline";
            return {
              source,
              result,
              endpointAccess,
              conditionId: borrowTypeConditionId({
                parameter: parameterIndex,
                sourcePath: source,
                resultPath: result,
                endpointAccess,
              }),
            };
          })
        : undefined;
      const accessIfResultTypeDiffers =
        preserveAbstractRegions && parameter.accessIfResultTypeDiffers
          ? (() => {
              const comparison = parameter.accessIfResultTypeDiffers;
              const sourcePath = publicPath(comparison.sourcePath);
              const resultPath = publicPath(comparison.resultPath);
              const endpointAccess =
                comparison.endpointAccess ?? ("inline" as const);
              return {
                ...comparison,
                sourcePath,
                resultPath,
                endpointAccess,
                conditionId: borrowTypeConditionId({
                  parameter: comparison.parameter,
                  sourcePath,
                  resultPath,
                  endpointAccess,
                }),
              };
            })()
          : undefined;
      return {
        access: parameter.access,
        ...(parameter.readPaths?.length
          ? { readPaths: publicPaths(parameter.readPaths) }
          : {}),
        ...(parameter.writePaths?.length
          ? { writePaths: publicPaths(parameter.writePaths) }
          : {}),
        ...(parameter.runtimeCheckedWrites
          ? { runtimeCheckedWrites: true }
          : {}),
        retained: parameter.retained,
        ...(parameter.retainedUnlessBorrowed
          ? { retainedUnlessBorrowed: true as const }
          : {}),
        returned: parameter.returned,
        ...(returnedAggregate ? { returnedAggregate: true as const } : {}),
        ...(parameter.retained
          ? {
              retainedPaths: publicPaths(
                parameter.retainedPaths?.length
                  ? parameter.retainedPaths
                  : [[]],
              ),
            }
          : {}),
        ...(parameter.externalRetainedPaths?.length
          ? {
              externalRetainedPaths: publicPaths(
                parameter.externalRetainedPaths,
              ),
            }
          : {}),
        ...(parameter.borrowedRetainedPaths?.length
          ? {
              borrowedRetainedPaths: publicPaths(
                parameter.borrowedRetainedPaths,
              ),
            }
          : {}),
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
        ...(returnedSharedOrigins.length > 0 ? { returnedSharedOrigins } : {}),
        ...(returnedTypeMatchingOrigins?.length
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(accessIfResultTypeDiffers ? { accessIfResultTypeDiffers } : {}),
        ...(parameter.defaultOrigins?.length
          ? {
              defaultOrigins: Array.from(
                new Map(
                  parameter.defaultOrigins.map((origin) => {
                    const publicOrigin = {
                      parameter: origin.parameter,
                      source: publicPath(origin.source),
                      result: publicPath(origin.result),
                      ...(origin.endpointAccess
                        ? { endpointAccess: origin.endpointAccess }
                        : {}),
                    };
                    return [
                      JSON.stringify(publicOrigin),
                      publicOrigin,
                    ] as const;
                  }),
                ).values(),
              ),
            }
          : {}),
        ...(parameter.defaultReadOrigins?.length
          ? {
              defaultReadOrigins: Array.from(
                new Map(
                  parameter.defaultReadOrigins.map((origin) => {
                    const publicOrigin = {
                      parameter: origin.parameter,
                      path: publicPath(origin.path),
                    };
                    return [
                      JSON.stringify(publicOrigin),
                      publicOrigin,
                    ] as const;
                  }),
                ).values(),
              ),
            }
          : {}),
        ...(parameter.defaultWriteOrigins?.length
          ? {
              defaultWriteOrigins: Array.from(
                new Map(
                  parameter.defaultWriteOrigins.map((origin) => {
                    const publicOrigin = {
                      parameter: origin.parameter,
                      path: publicPath(origin.path),
                    };
                    return [
                      JSON.stringify(publicOrigin),
                      publicOrigin,
                    ] as const;
                  }),
                ).values(),
              ),
            }
          : {}),
        ...(parameter.defaultExternalOrigins?.length
          ? {
              defaultExternalOrigins: publicExternalOrigins(
                parameter.defaultExternalOrigins,
              ),
            }
          : {}),
        ...(parameter.defaultExternalReturnedOrigins?.length
          ? {
              defaultExternalReturnedOrigins: publicExternalOrigins(
                parameter.defaultExternalReturnedOrigins,
              ),
            }
          : {}),
        ...(parameter.defaultExternalRead
          ? { defaultExternalRead: true as const }
          : {}),
        ...(parameter.defaultExternalWrite
          ? { defaultExternalWrite: true as const }
          : {}),
        ...(parameter.defaultBorrowedResult
          ? { defaultBorrowedResult: parameter.defaultBorrowedResult }
          : {}),
      };
    }),
    maySuspend: contract.maySuspend,
    ...(contract.freshResult ? { freshResult: true as const } : {}),
    ...(contract.borrowedResult
      ? { borrowedResult: contract.borrowedResult }
      : {}),
    ...(contract.externalReturnedOrigins?.length
      ? {
          externalReturnedOrigins: publicExternalOrigins(
            contract.externalReturnedOrigins,
          ),
        }
      : {}),
    ...(contract.externalRead ? { externalRead: true as const } : {}),
    ...(contract.externalWrite ? { externalWrite: true as const } : {}),
    ...(contract.transfers?.length
      ? {
          transfers: contract.transfers.map((transfer) => ({
            ...transfer,
            ...(transfer.sourcePath
              ? { sourcePath: publicPath(transfer.sourcePath) }
              : {}),
            ...(transfer.destinationPath
              ? { destinationPath: publicPath(transfer.destinationPath) }
              : {}),
            conservative: true as const,
          })),
        }
      : {}),
    ...(contract.scopedCallbacks?.length
      ? {
          scopedCallbacks: contract.scopedCallbacks.map((callback) => {
            const { callbackPath: _callbackPath, ...publicCallback } = callback;
            return publicCallback;
          }),
        }
      : {}),
    ...(contract.callableResultInvocations?.some(
      (invocation) =>
        invocation.source.length === 0 &&
        invocation.callbackResult.length === 0 &&
        invocation.result.length === 0,
    )
      ? {
          callableResultInvocations: contract.callableResultInvocations.filter(
            (invocation) =>
              invocation.source.length === 0 &&
              invocation.callbackResult.length === 0 &&
              invocation.result.length === 0,
          ),
        }
      : {}),
  };
};

const isWireSummary = (value: unknown): value is WireCallableBorrowSummary => {
  if (
    !isRecordWithKeys(value, [
      "schema",
      "version",
      "dispatch",
      "contract",
      "namedContract",
      "source",
    ]) ||
    value.schema !== CALLABLE_BORROW_SUMMARY_SCHEMA ||
    (value.version !== LEGACY_CALLABLE_BORROW_SUMMARY_VERSION &&
      value.version !== IDENTITY_GUARD_CALLABLE_BORROW_SUMMARY_VERSION &&
      value.version !== FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION &&
      value.version !== CALLABLE_BORROW_SUMMARY_VERSION) ||
    !isOneOf(value.dispatch, [
      "ordinary",
      "trait-declaration",
      "trait-implementation",
    ]) ||
    !isWireContract(value.contract, value.version) ||
    (value.namedContract !== undefined &&
      (!(
        value.dispatch === "trait-declaration" ||
        value.dispatch === "trait-implementation"
      ) ||
        !isWireNamedContract(value.namedContract))) ||
    (value.source !== undefined && !isWireSource(value.source))
  ) {
    return false;
  }
  return value.namedContract
    ? wireContractMatchesNamedRegions(value.contract, value.namedContract)
    : wireContractHasNoDisjointRegions(value.contract);
};

const wireContractHasNoDisjointRegions = (contract: WireContract): boolean => {
  let valid = true;
  const visit = (value: unknown): void => {
    if (!valid) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (value.kind === "region") {
      valid = Array.isArray(value.disjoint) && value.disjoint.length === 0;
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(contract);
  return valid;
};

const wireContractMatchesNamedRegions = (
  contract: WireContract,
  named: WireNamedContractV1,
): boolean => {
  const disjointByRegion = new Map(
    named.regions.map((region) => [
      region,
      named.disjoint
        .flatMap(([left, right]) =>
          left === region ? [right] : right === region ? [left] : [],
        )
        .sort(),
    ]),
  );
  let valid = true;
  const visit = (value: unknown): void => {
    if (!valid) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (value.kind === "region") {
      if (
        value.scope === PRIVATE_SUMMARY_REGION_SCOPE &&
        typeof value.name === "string" &&
        (value.name === PRIVATE_SUMMARY_REGION_NAME ||
          value.name.startsWith(`${PRIVATE_SUMMARY_REGION_NAME}:`))
      ) {
        valid = Array.isArray(value.disjoint) && value.disjoint.length === 0;
        return;
      }
      const expected =
        typeof value.name === "string"
          ? disjointByRegion.get(value.name)
          : undefined;
      const actual = Array.isArray(value.disjoint)
        ? [...value.disjoint].sort()
        : undefined;
      valid =
        value.scope === named.scope &&
        expected !== undefined &&
        JSON.stringify(actual) === JSON.stringify(expected);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(contract);
  return valid;
};

const isWireContract = (
  value: unknown,
  version:
    | typeof LEGACY_CALLABLE_BORROW_SUMMARY_VERSION
    | typeof IDENTITY_GUARD_CALLABLE_BORROW_SUMMARY_VERSION
    | typeof FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION
    | typeof CALLABLE_BORROW_SUMMARY_VERSION,
): value is WireContract => {
  const keys = [
    "parameters",
    "maySuspend",
    ...(version === FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION ||
    version === CALLABLE_BORROW_SUMMARY_VERSION
      ? ["freshResult"]
      : []),
    ...(version !== LEGACY_CALLABLE_BORROW_SUMMARY_VERSION
      ? ["defaultIdentityGuardProtocol"]
      : []),
    "borrowedResult",
    "externalReturnedOrigins",
    "externalRead",
    "externalWrite",
    "transfers",
    "scopedCallbacks",
    ...(version === CALLABLE_BORROW_SUMMARY_VERSION
      ? ["callableResultInvocations"]
      : []),
  ];
  if (
    !isRecordWithKeys(value, keys) ||
    !Array.isArray(value.parameters) ||
    !value.parameters.every(isWireParameter) ||
    typeof value.maySuspend !== "boolean" ||
    ((version === FRESH_RESULT_CALLABLE_BORROW_SUMMARY_VERSION ||
      version === CALLABLE_BORROW_SUMMARY_VERSION) &&
      !optionalTrue(value.freshResult)) ||
    (version !== LEGACY_CALLABLE_BORROW_SUMMARY_VERSION &&
      value.defaultIdentityGuardProtocol !== undefined &&
      value.defaultIdentityGuardProtocol !== "presence-conflict-bit-v1") ||
    (value.borrowedResult !== undefined &&
      !isOneOf(value.borrowedResult, ["none", "parameter", "external"])) ||
    !optionalArray(
      value.externalReturnedOrigins,
      isWireExternalReturnedOrigin,
    ) ||
    !optionalTrue(value.externalRead) ||
    !optionalTrue(value.externalWrite) ||
    (value.transfers !== undefined &&
      (!Array.isArray(value.transfers) ||
        !value.transfers.every(isWireTransfer))) ||
    (value.scopedCallbacks !== undefined &&
      (!Array.isArray(value.scopedCallbacks) ||
        !value.scopedCallbacks.every(isWireScopedCallback))) ||
    ("callableResultInvocations" in value &&
      value.callableResultInvocations !== undefined &&
      (!Array.isArray(value.callableResultInvocations) ||
        !value.callableResultInvocations.every(isWireCallableResultInvocation)))
  ) {
    return false;
  }
  const contract = value as WireContract;
  const parameterCount = contract.parameters.length;
  const parameterInRange = (parameter: number): boolean =>
    parameter < parameterCount;
  return (
    contract.parameters.every(
      (parameter) =>
        (parameter.accessIfResultTypeDiffers === undefined ||
          parameterInRange(parameter.accessIfResultTypeDiffers.parameter)) &&
        (parameter.defaultOrigins?.every((origin) =>
          parameterInRange(origin.parameter),
        ) ??
          true) &&
        (parameter.defaultReadOrigins?.every((origin) =>
          parameterInRange(origin.parameter),
        ) ??
          true) &&
        (parameter.defaultWriteOrigins?.every((origin) =>
          parameterInRange(origin.parameter),
        ) ??
          true),
    ) &&
    (contract.transfers?.every(
      (transfer) =>
        parameterInRange(transfer.sourceParameter) &&
        parameterInRange(transfer.destinationParameter),
    ) ??
      true) &&
    (contract.scopedCallbacks?.every(
      (callback) =>
        parameterInRange(callback.callbackParameter) &&
        parameterInRange(callback.callbackValueParameter),
    ) ??
      true) &&
    ("callableResultInvocations" in contract
      ? (contract.callableResultInvocations?.every((invocation) =>
          parameterInRange(invocation.parameter),
        ) ?? true)
      : true)
  );
};

const isWireCallableResultInvocation = (
  value: unknown,
): value is WireCallableResultInvocationV4 =>
  isRecordWithKeys(value, [
    "parameter",
    "source",
    "callbackResult",
    "callbackResultType",
    "result",
  ]) &&
  isNonNegativeInteger(value.parameter) &&
  isWirePath(value.source) &&
  isWirePath(value.callbackResult) &&
  (value.callbackResultType === undefined ||
    (isRecordWithKeys(value.callbackResultType, ["moduleId", "symbol"]) &&
      typeof value.callbackResultType.moduleId === "string" &&
      isNonNegativeInteger(value.callbackResultType.symbol))) &&
  isWirePath(value.result);

const isWireExternalReturnedOrigin = (
  value: unknown,
): value is WireExternalReturnedOriginV1 =>
  isRecordWithKeys(value, ["result", "endpointAccess", "fresh"]) &&
  isWirePath(value.result) &&
  (value.endpointAccess === undefined ||
    isOneOf(value.endpointAccess, ["inline", "dereferenced"])) &&
  optionalTrue(value.fresh);

const PARAMETER_KEYS = [
  "access",
  "readPaths",
  "writePaths",
  "runtimeCheckedWrites",
  "retained",
  "retainedUnlessBorrowed",
  "returned",
  "returnedAggregate",
  "retainedPaths",
  "externalRetainedPaths",
  "borrowedRetainedPaths",
  "returnedPaths",
  "returnedOrigins",
  "returnedSharedOrigins",
  "returnedTypeMatchingOrigins",
  "accessIfResultTypeDiffers",
  "invalidatedPaths",
  "defaultOrigins",
  "defaultReadOrigins",
  "defaultWriteOrigins",
  "defaultExternalOrigins",
  "defaultExternalReturnedOrigins",
  "defaultExternalRead",
  "defaultExternalWrite",
  "defaultBorrowedResult",
  "defaultNoBorrowPaths",
] as const;

const isWireParameter = (value: unknown): value is WireParameterContractV1 =>
  isRecordWithKeys(value, PARAMETER_KEYS) &&
  isOneOf(value.access, ["owned", "shared", "mutable"]) &&
  optionalPaths(value.readPaths) &&
  optionalPaths(value.writePaths) &&
  (value.runtimeCheckedWrites === undefined ||
    value.runtimeCheckedWrites === true) &&
  typeof value.retained === "boolean" &&
  optionalTrue(value.retainedUnlessBorrowed) &&
  typeof value.returned === "boolean" &&
  optionalTrue(value.returnedAggregate) &&
  optionalPaths(value.retainedPaths) &&
  optionalPaths(value.externalRetainedPaths) &&
  optionalPaths(value.borrowedRetainedPaths) &&
  optionalPaths(value.returnedPaths) &&
  optionalArray(value.returnedOrigins, isWireOrigin) &&
  optionalArray(value.returnedSharedOrigins, isWireOrigin) &&
  optionalArray(value.returnedTypeMatchingOrigins, isWireTypeMatchingOrigin) &&
  (value.accessIfResultTypeDiffers === undefined ||
    isWireTypeComparison(value.accessIfResultTypeDiffers)) &&
  optionalPaths(value.invalidatedPaths) &&
  optionalArray(value.defaultOrigins, isWireDefaultOrigin) &&
  optionalArray(value.defaultReadOrigins, isWireDefaultAccessOrigin) &&
  optionalArray(value.defaultWriteOrigins, isWireDefaultAccessOrigin) &&
  optionalArray(value.defaultExternalOrigins, isWireExternalReturnedOrigin) &&
  optionalArray(
    value.defaultExternalReturnedOrigins,
    isWireExternalReturnedOrigin,
  ) &&
  optionalTrue(value.defaultExternalRead) &&
  optionalTrue(value.defaultExternalWrite) &&
  (value.defaultBorrowedResult === undefined ||
    value.defaultBorrowedResult === "none") &&
  optionalPaths(value.defaultNoBorrowPaths);

const isWireProjection = (value: unknown): value is WireProjectionV1 => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "field":
      return (
        hasOnlyKeys(value, ["kind", "name"]) && typeof value.name === "string"
      );
    case "tuple":
      return (
        hasOnlyKeys(value, ["kind", "index"]) &&
        isNonNegativeInteger(value.index)
      );
    case "index":
      return (
        hasOnlyKeys(value, ["kind", "constant", "stable"]) &&
        typeof value.stable === "boolean" &&
        (value.constant === undefined || Number.isInteger(value.constant))
      );
    case "region":
      return (
        hasOnlyKeys(value, ["kind", "scope", "name", "disjoint"]) &&
        typeof value.scope === "string" &&
        typeof value.name === "string" &&
        isStringArray(value.disjoint)
      );
    case "discriminant":
    case "dereference":
    case "identity":
      return hasOnlyKeys(value, ["kind"]);
    default:
      return false;
  }
};

const isWirePath = (value: unknown): value is readonly WireProjectionV1[] =>
  Array.isArray(value) && value.every(isWireProjection);

const optionalPaths = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(isWirePath));

const isWireOrigin = (value: unknown): value is WireOriginV1 =>
  isRecordWithKeys(value, [
    "source",
    "result",
    "endpointAccess",
    "defaultNoBorrow",
  ]) &&
  isWirePath(value.source) &&
  isWirePath(value.result) &&
  optionalEndpoint(value.endpointAccess) &&
  optionalTrue(value.defaultNoBorrow);

const isWireTypeMatchingOrigin = (
  value: unknown,
): value is WireTypeMatchingOriginV1 =>
  isRecordWithKeys(value, [
    "source",
    "result",
    "endpointAccess",
    "defaultNoBorrow",
    "conditionId",
  ]) &&
  isWirePath(value.source) &&
  isWirePath(value.result) &&
  optionalEndpoint(value.endpointAccess) &&
  optionalTrue(value.defaultNoBorrow) &&
  typeof value.conditionId === "string";

const isWireTypeComparison = (value: unknown): value is WireTypeComparisonV1 =>
  isRecordWithKeys(value, [
    "conditionId",
    "parameter",
    "sourcePath",
    "resultPath",
    "endpointAccess",
  ]) &&
  typeof value.conditionId === "string" &&
  isNonNegativeInteger(value.parameter) &&
  isWirePath(value.sourcePath) &&
  isWirePath(value.resultPath) &&
  optionalEndpoint(value.endpointAccess);

const isWireDefaultOrigin = (value: unknown): value is WireDefaultOriginV1 =>
  isRecordWithKeys(value, [
    "parameter",
    "source",
    "result",
    "endpointAccess",
  ]) &&
  isNonNegativeInteger(value.parameter) &&
  isWirePath(value.source) &&
  isWirePath(value.result) &&
  optionalEndpoint(value.endpointAccess);

const isWireDefaultAccessOrigin = (
  value: unknown,
): value is WireDefaultAccessOriginV1 =>
  isRecordWithKeys(value, ["parameter", "path"]) &&
  isNonNegativeInteger(value.parameter) &&
  isWirePath(value.path);

const isWireTransfer = (value: unknown): value is WireTransferV1 =>
  isRecordWithKeys(value, [
    "sourceParameter",
    "destinationParameter",
    "sourcePath",
    "destinationPath",
    "sourceInvalidated",
    "borrowsSource",
    "conservative",
  ]) &&
  isNonNegativeInteger(value.sourceParameter) &&
  isNonNegativeInteger(value.destinationParameter) &&
  (value.sourcePath === undefined || isWirePath(value.sourcePath)) &&
  (value.destinationPath === undefined || isWirePath(value.destinationPath)) &&
  optionalTrue(value.sourceInvalidated) &&
  optionalTrue(value.borrowsSource) &&
  optionalTrue(value.conservative);

const isWireScopedCallback = (value: unknown): value is WireScopedCallbackV1 =>
  isRecordWithKeys(value, [
    "callbackParameter",
    "callbackValueParameter",
    "access",
    "callbackPath",
    "defaultCallbackBehavior",
  ]) &&
  isNonNegativeInteger(value.callbackParameter) &&
  isNonNegativeInteger(value.callbackValueParameter) &&
  isOneOf(value.access, ["shared", "mutable"]) &&
  (value.callbackPath === undefined || isStringArray(value.callbackPath)) &&
  (value.defaultCallbackBehavior === undefined ||
    isOneOf(value.defaultCallbackBehavior, ["safe", "escapes", "unknown"]));

const isWireNamedContract = (value: unknown): value is WireNamedContractV1 => {
  if (
    !isRecordWithKeys(value, [
      "scope",
      "regions",
      "disjoint",
      "reads",
      "mutates",
      "returnsFrom",
    ]) ||
    typeof value.scope !== "string" ||
    !isStringArray(value.regions) ||
    !Array.isArray(value.disjoint) ||
    !value.disjoint.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((entry) => typeof entry === "string"),
    ) ||
    !isStringArray(value.reads) ||
    !isStringArray(value.mutates) ||
    !isStringArray(value.returnsFrom)
  ) {
    return false;
  }
  const named = value as WireNamedContractV1;
  const regions = new Set(named.regions);
  return (
    regions.size === named.regions.length &&
    named.disjoint.every(
      ([left, right]) =>
        left !== right && regions.has(left) && regions.has(right),
    ) &&
    [...named.reads, ...named.mutates, ...named.returnsFrom].every((region) =>
      regions.has(region),
    )
  );
};

const isWireSource = (value: unknown): value is WireSummarySourceV1 =>
  isRecordWithKeys(value, ["declaration", "parameters"]) &&
  isWireSpan(value.declaration) &&
  Array.isArray(value.parameters) &&
  value.parameters.every(isWireSpan);

const isWireSpan = (value: unknown): value is WireSummarySpanV1 =>
  isRecordWithKeys(value, ["moduleId", "start", "end"]) &&
  typeof value.moduleId === "string" &&
  isNonNegativeInteger(value.start) &&
  isNonNegativeInteger(value.end) &&
  value.end >= value.start;

const optionalEndpoint = (value: unknown): boolean =>
  value === undefined || value === "inline" || value === "dereferenced";

const optionalTrue = (value: unknown): boolean =>
  value === undefined || value === true;

const optionalArray = (
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((entry) => predicate(entry)));

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
};

const isRecordWithKeys = <K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> => isRecord(value) && hasOnlyKeys(value, keys);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isOneOf = <T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T => typeof value === "string" && choices.includes(value as T);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidSummary = (reason: string): Error =>
  new Error(`invalid callable borrow summary: ${reason}`);
