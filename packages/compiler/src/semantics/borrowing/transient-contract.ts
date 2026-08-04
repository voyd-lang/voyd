import {
  diagnosticFromCode,
  type Diagnostic,
} from "../../diagnostics/index.js";
import type { SymbolId } from "../ids.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type {
  BorrowPlace,
  CallableBorrowContract,
  CallableParameterBorrowContract,
  PlaceProjection,
} from "./model.js";
import {
  mergeCallableBorrowContracts,
  projectionPathCovers,
  projectionPathsOverlap,
} from "./model.js";
import {
  indexCallArgumentFor,
  parameterPlaceForIndexPlace,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type { LoanAnalysisMode } from "./capability.js";
import type { ImportedCallableCapability } from "./capability-classifier.js";
import { transientParameterPairKey } from "./transient-guards.js";
import { COMPACT_BORROW_INTRINSICS } from "./call-resolution.js";

export type CallableContractLookup = {
  localModuleId: string;
  localCapabilities: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  localContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
};

type ParameterEffect = {
  readPaths: Map<string, readonly PlaceProjection[]>;
  writePaths: Map<string, readonly PlaceProjection[]>;
  runtimeCheckedWrites: boolean;
};

const keyFor = (target: SymbolRef): string =>
  `${target.moduleId}:${target.symbol}`;

const pathKey = (path: readonly PlaceProjection[]): string =>
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

const pathStaysWithinRootAllocation = (
  path: readonly PlaceProjection[],
): boolean => {
  const projections = path.filter(
    (projection) => projection.kind !== "identity",
  );
  const dereference = projections.findIndex(
    (projection) => projection.kind === "dereference",
  );
  if (dereference < 0) return true;
  return (
    dereference === 0 &&
    projections.length <= 2 &&
    projections.slice(1).every((projection) => projection.kind !== "dereference")
  );
};

const addPath = (
  paths: Map<string, readonly PlaceProjection[]>,
  path: readonly PlaceProjection[],
): void => {
  if (
    Array.from(paths.values()).some((existing) =>
      projectionPathCovers(existing, path),
    )
  ) {
    return;
  }
  Array.from(paths).forEach(([key, existing]) => {
    if (projectionPathCovers(path, existing)) paths.delete(key);
  });
  paths.set(pathKey(path), path);
};

const sortedPaths = (
  paths: ReadonlyMap<string, readonly PlaceProjection[]>,
): readonly (readonly PlaceProjection[])[] =>
  Array.from(paths)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, path]) => path);

const parameterEffects = (
  parameter: CallableParameterBorrowContract,
): {
  reads: readonly (readonly PlaceProjection[])[];
  writes: readonly (readonly PlaceProjection[])[];
} => ({
  reads: parameter.readPaths ?? [],
  writes: parameter.writePaths ?? [],
});

const contractForTarget = (
  target: SymbolRef,
  lookup: CallableContractLookup,
): CallableBorrowContract | undefined =>
  target.moduleId === lookup.localModuleId
    ? lookup.localContracts.get(target.symbol)
    : lookup.importedCallables.get(keyFor(target))?.contract;

export const contractFromBorrowIndex = (
  index: CallableBorrowIndex,
): CallableBorrowContract => {
  const effects = directEffects(index);
  return {
    parameters: index.parameters.map((parameter, parameterIndex) => {
      const effect = effects[parameterIndex]!;
      const readPaths = sortedPaths(effect.readPaths);
      const writePaths = sortedPaths(effect.writePaths);
      return {
        access: parameter.access,
        ...(readPaths.length > 0 ? { readPaths } : {}),
        ...(writePaths.length > 0 ? { writePaths } : {}),
        ...(parameterIndex === 0 && index.flags.hasRuntimeCheckedReceiverWrites
          ? { runtimeCheckedWrites: true as const }
          : {}),
        ...(index.flags.hasMutableReferenceRebinding &&
        parameter.bindingKind === "mutable-ref"
          ? { invalidatedPaths: [[]] }
          : {}),
        retained: false,
        returned: false,
      };
    }),
    maySuspend: false,
    borrowedResult: "none",
    ...(index.flags.hasSyntacticFreshResult
      ? { freshResult: true as const }
      : {}),
    ...(index.flags.hasModuleStorageAccess
      ? { externalRead: true as const }
      : {}),
    ...(index.flags.hasModuleStorageWrite
      ? { externalWrite: true as const }
      : {}),
  };
};

const placeForArgument = (
  call: CallableBorrowIndexCall,
  parameter: number,
): BorrowPlace | undefined => indexCallArgumentFor(call, parameter)?.place;

const addTranslatedEffects = ({
  effects,
  index,
  argumentPlace,
  allowUnmapped,
  parameter,
}: {
  effects: ParameterEffect[];
  index: CallableBorrowIndex;
  argumentPlace: BorrowPlace;
  allowUnmapped: boolean;
  parameter: CallableParameterBorrowContract;
}): boolean => {
  const paths = parameterEffects(parameter);
  if (paths.reads.length === 0 && paths.writes.length === 0) return true;
  const source = parameterPlaceForIndexPlace(index, argumentPlace);
  if (!source) return allowUnmapped;
  const target = effects[source.parameter];
  if (!target) return true;
  paths.reads.forEach((path) =>
    addPath(target.readPaths, [...source.path, ...path]),
  );
  paths.writes.forEach((path) =>
    addPath(target.writePaths, [...source.path, ...path]),
  );
  target.runtimeCheckedWrites &&=
    parameter.runtimeCheckedWrites === true || paths.writes.length === 0;
  return true;
};

const mergeParameterEffects = ({
  contract,
  effects,
}: {
  contract: CallableBorrowContract;
  effects: readonly ParameterEffect[];
}): CallableBorrowContract => ({
  ...contract,
  parameters: contract.parameters.map((parameter, index) => {
    const effect = effects[index];
    if (!effect) return parameter;
    const readPaths = sortedPaths(effect.readPaths);
    const writePaths = sortedPaths(effect.writePaths);
    return {
      ...parameter,
      ...(readPaths.length > 0 ? { readPaths } : {}),
      ...(writePaths.length > 0 ? { writePaths } : {}),
      ...(writePaths.length > 0 && effect.runtimeCheckedWrites
        ? { runtimeCheckedWrites: true as const }
        : {}),
    };
  }),
});

const directEffects = (index: CallableBorrowIndex): ParameterEffect[] => {
  const effects = index.parameters.map(() => ({
    readPaths: new Map<string, readonly PlaceProjection[]>(),
    writePaths: new Map<string, readonly PlaceProjection[]>(),
    runtimeCheckedWrites: true,
  }));
  index.accesses.forEach((access) => {
    if (
      access.role === "projection-base" ||
      (access.role === "call-argument" && access.referenceArgument === true) ||
      access.role === "call-operand" ||
      (access.role === "assignment-target" && access.kind === "read")
    ) {
      return;
    }
    const source = parameterPlaceForIndexPlace(index, access.place);
    if (!source) {
      return;
    }
    const effect = effects[source.parameter];
    if (!effect) return;
    addPath(
      access.kind === "write" ? effect.writePaths : effect.readPaths,
      source.path,
    );
    if (access.kind === "write") {
      effect.runtimeCheckedWrites &&=
        index.flags.hasRuntimeCheckedReceiverWrites && source.parameter === 0;
    }
  });
  index.calls.forEach((call) => {
    const addIntrinsicPath = (
      parameter: number,
      kind: "read" | "write",
      path: readonly PlaceProjection[],
    ): void => {
      const argument = placeForArgument(call, parameter);
      const source = parameterPlaceForIndexPlace(index, argument);
      if (!source) return;
      addPath(
        kind === "write"
          ? effects[source.parameter]!.writePaths
          : effects[source.parameter]!.readPaths,
        [...source.path, ...path],
      );
    };
    switch (call.intrinsicName) {
      case "__array_get":
        addIntrinsicPath(0, "read", [
          { kind: "dereference" },
          ...(call.intrinsicIndex
            ? [call.intrinsicIndex]
            : [{ kind: "index" as const, stable: false }]),
        ]);
        break;
      case "__array_set":
        addIntrinsicPath(0, "write", [
          { kind: "dereference" },
          ...(call.intrinsicIndex
            ? [call.intrinsicIndex]
            : [{ kind: "index" as const, stable: false }]),
        ]);
        break;
      case "__array_len":
      case "__ref_is_null":
        addIntrinsicPath(0, "read", [{ kind: "identity" }]);
        break;
      default:
        break;
    }
  });
  return effects;
};

const targetContractsForCall = (
  call: CallableBorrowIndexCall,
  lookup: CallableContractLookup,
): readonly CallableBorrowContract[] => {
  const contracts = call.targets.flatMap((target) => {
    const contract = contractForTarget(target, lookup);
    return contract ? [contract] : [];
  });
  return contracts;
};

/**
 * Compose the exact footprint for a transient callable without constructing
 * full facts. `undefined` means the caller's classifier was not conservative
 * enough for this boundary and the callable must use the flow path.
 */
export const composeTransientCallableContract = ({
  index,
  declaredContract,
  lookup,
}: {
  index: CallableBorrowIndex;
  declaredContract?: CallableBorrowContract;
  lookup: CallableContractLookup;
}): CallableBorrowContract | undefined => {
  const effects = directEffects(index);
  let externalRead = index.flags.hasModuleStorageAccess;
  let externalWrite = index.flags.hasModuleStorageWrite;
  for (const call of index.calls) {
    if (
      call.intrinsic &&
      call.intrinsicName !== undefined &&
      call.targets.length === 0 &&
      !call.returnsBorrowed &&
      !COMPACT_BORROW_INTRINSICS.has(call.intrinsicName)
    ) {
      continue;
    }
    if (
      call.intrinsic &&
      call.intrinsicBoundary &&
      call.intrinsicName !== undefined &&
      call.intrinsicName !== "~" &&
      call.intrinsicName !== "__shared_cell_value" &&
      !["+", "-", "*", "/", "%"].includes(call.intrinsicName)
    ) {
      continue;
    }
    const targets = targetContractsForCall(call, lookup);
    const target = mergeCallableBorrowContracts(targets);
    if (!target) continue;
    externalRead ||= target.externalRead === true;
    externalWrite ||= target.externalWrite === true;
    for (const [parameterIndex, parameter] of target.parameters.entries()) {
      const argument = indexCallArgumentFor(call, parameterIndex);
      const argumentPlace = argument?.place;
      const paths = parameterEffects(parameter);
      if (argument?.moduleStorage === true) {
        externalRead ||= paths.reads.length > 0;
        externalWrite ||= paths.writes.length > 0;
      }
      if (
        (paths.reads.length > 0 || paths.writes.length > 0) &&
        !argumentPlace
      ) {
        return undefined;
      }
      if (!argumentPlace) continue;
      const staysWithinFreshRoot = [...paths.reads, ...paths.writes].every(
        pathStaysWithinRootAllocation,
      );
      if (
        !addTranslatedEffects({
          effects,
          index,
          argumentPlace,
          allowUnmapped:
            argument?.moduleStorage === true ||
            (argument?.fresh === true && staysWithinFreshRoot),
          parameter,
        })
      ) {
        return undefined;
      }
    }
  }
  const bodyContract = mergeParameterEffects({
    contract: contractFromBorrowIndex(index),
    effects,
  });
  const storageContract = {
    ...bodyContract,
    ...(externalRead ? { externalRead: true as const } : {}),
    ...(externalWrite ? { externalWrite: true as const } : {}),
  };
  if (!declaredContract) return storageContract;
  return mergeCallableBorrowContracts([storageContract, declaredContract]);
};

const displayPlace = (
  index: CallableBorrowIndex,
  place: BorrowPlace,
): string => {
  const parameter = parameterPlaceForIndexPlace(index, place);
  if (!parameter) return "an unknown place";
  const suffix = parameter.path
    .map((projection) =>
      projection.kind === "field"
        ? `.${projection.name}`
        : projection.kind === "tuple"
          ? `[${projection.index}]`
          : "",
    )
    .join("");
  return `parameter ${parameter.parameter + 1}${suffix}`;
};

const accessPathsForParameter = (
  parameter: CallableParameterBorrowContract,
): readonly {
  access: "shared" | "mutable";
  path: readonly PlaceProjection[];
}[] => {
  const effects = parameterEffects(parameter);
  return [
    ...effects.reads.map((path) => ({ access: "shared" as const, path })),
    ...effects.writes.map((path) => ({ access: "mutable" as const, path })),
  ];
};

/** Check only overlaps formed by two arguments to one transient call. */
export const checkTransientSameCallOverlaps = ({
  index,
  lookup,
  guardedPairs = new Map(),
}: {
  index: CallableBorrowIndex;
  lookup: CallableContractLookup;
  guardedPairs?: ReadonlyMap<number, ReadonlySet<string>>;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  index.calls.forEach((call) => {
    if (call.targets.length === 0) return;
    const contracts = targetContractsForCall(call, lookup);
    const contract = mergeCallableBorrowContracts(contracts);
    if (!contract) {
      return;
    }
    const accesses = [
      ...contract.parameters.flatMap((parameter, parameterIndex) =>
        accessPathsForParameter(parameter).flatMap((entry) => {
          const argument = placeForArgument(call, parameterIndex);
          return argument ? [{ ...entry, argument, parameterIndex }] : [];
        }),
      ),
      ...(call.returnsBorrowed
        ? (call.signature?.parameters.flatMap((parameter, parameterIndex) =>
            parameter.bindingKind === "mutable-ref" ||
            parameter.bindingKind === "immutable-ref" ||
            parameter.declaredType?.typeKind === "borrowed"
              ? (() => {
                  const argument = placeForArgument(call, parameterIndex);
                  return argument
                    ? [
                        {
                          access: "shared" as const,
                          path: [] as const,
                          argument,
                          parameterIndex,
                        },
                      ]
                    : [];
                })()
              : [],
          ) ?? [])
        : []),
    ];
    for (let leftIndex = 0; leftIndex < accesses.length; leftIndex += 1) {
      const left = accesses[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < accesses.length;
        rightIndex += 1
      ) {
        const right = accesses[rightIndex]!;
        if (left.parameterIndex === right.parameterIndex) continue;
        if (
          guardedPairs
            .get(call.exprId)
            ?.has(
              transientParameterPairKey(
                left.parameterIndex,
                right.parameterIndex,
              ),
            )
        ) {
          continue;
        }
        if (left.argument.root !== right.argument.root) continue;
        const pathsOverlap = projectionPathsOverlap(
          [...left.argument.projections, ...left.path],
          [...right.argument.projections, ...right.path],
        );
        if (!pathsOverlap) continue;
        if (left.access !== "mutable" && right.access !== "mutable") continue;
        const mutable = left.access === "mutable" ? left : right;
        const existing = left.access === "mutable" ? right : left;
        diagnostics.push(
          diagnosticFromCode({
            code: "TY0048",
            params: {
              kind: "borrow-conflict",
              access: "mutably borrow",
              place: displayPlace(index, mutable.argument),
              existing: existing.access,
            },
            span: call.span,
            related: [
              diagnosticFromCode({
                code: "TY0048",
                params: {
                  kind: "borrow-origin",
                  place: displayPlace(index, existing.argument),
                  borrow: existing.access,
                },
                span: call.span,
                severity: "note",
              }),
            ],
          }),
        );
        return;
      }
      if (diagnostics.at(-1)?.span.start === call.span.start) return;
    }
  });
  return diagnostics;
};
