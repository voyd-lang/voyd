import type { SourceSpan } from "../ids.js";
import type {
  CallableBorrowContract,
  CallableParameterBorrowContract,
  CheckedNamedBorrowContract,
  PlaceProjection,
  ReturnedBorrowOrigin,
} from "./model.js";
import { borrowTypeConditionId, projectionPathCovers } from "./model.js";

export const CALLABLE_BORROW_SUMMARY_SCHEMA =
  "voyd.callable-borrow-summary" as const;
export const CALLABLE_BORROW_SUMMARY_VERSION = 4 as const;
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
  if (!redaction) return path;
  const privateStorageProjection = (): PlaceProjection => ({
    kind: "region",
    scope: PRIVATE_SUMMARY_REGION_SCOPE,
    name: `${PRIVATE_SUMMARY_REGION_NAME}:${redaction.token}`,
    disjoint: [],
  });
  if (path.length === 0 && redaction.index === 0) {
    return [privateStorageProjection()];
  }
  const privatePath: PlaceProjection[] = [];
  let hasHiddenSegment = false;
  path.slice(redaction.index).forEach((projection) => {
    if (projection.kind !== "dereference") {
      hasHiddenSegment = true;
      return;
    }
    if (hasHiddenSegment) privatePath.push(privateStorageProjection());
    privatePath.push(projection);
    hasHiddenSegment = false;
  });
  if (hasHiddenSegment) privatePath.push(privateStorageProjection());
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

type CallableBorrowSummaryOptions = {
  contract: CallableBorrowContract;
  namedContract?: CheckedNamedBorrowContract;
  dispatchHint?: Exclude<CallableBorrowDispatchKind, "ordinary">;
  publicAbstraction?: boolean;
  publicPrivacy?: CallableBorrowSummaryPrivacy;
  source?: CallableBorrowSummarySource;
};

/** Builds the compact caller-visible borrowing result shared by source analysis. */
export const createCallableBorrowSummary = ({
  contract,
  namedContract,
  dispatchHint,
  publicAbstraction = false,
  publicPrivacy,
  source,
}: CallableBorrowSummaryOptions): CallableBorrowSummary => {
  const dispatch =
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
  return {
    schema: CALLABLE_BORROW_SUMMARY_SCHEMA,
    version: CALLABLE_BORROW_SUMMARY_VERSION,
    dispatch,
    contract: namedContract
      ? publicContract
      : stripRegionDisjointness(publicContract),
    ...(namedContract
      ? { namedContract: publicNamedContract(namedContract) }
      : {}),
    ...(source
      ? {
          source: {
            declaration: { ...source.declaration },
            parameters: source.parameters.map((parameter) => ({
              ...parameter,
            })),
          },
        }
      : {}),
  };
};

export const summarySpanToSourceSpan = (
  span: CallableBorrowSummarySpan,
): SourceSpan => ({ file: span.moduleId, start: span.start, end: span.end });

const publicNamedContract = (
  contract: CheckedNamedBorrowContract,
): PublicNamedBorrowContract => ({
  scope: contract.scope,
  regions: contract.regions.map((region) => region.name),
  disjoint: contract.disjoint.map(([left, right]) => [left, right]),
  reads: [...contract.reads],
  mutates: [...contract.mutates],
  returnsFrom: [...contract.returnsFrom],
});

const stripRegionDisjointness = (
  contract: CallableBorrowContract,
): CallableBorrowContract => {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        record.kind === "region" && key === "disjoint" ? [] : strip(entry),
      ]),
    );
  };
  return strip(contract) as CallableBorrowContract;
};

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
