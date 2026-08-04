import type { SymbolId, TypeId } from "../ids.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { TypingResult } from "../typing/index.js";
import type {
  BorrowPlace,
  CallableBorrowContract,
  CallableParameterBorrowContract,
  PlaceProjection,
  RuntimeIdentityGuard,
} from "./model.js";
import {
  callableContractAllowsRuntimeIdentityGuards,
  mergeCallableBorrowContracts,
  projectionPathsOverlap,
  runtimeIdentityGuardParameterCanEscape,
} from "./model.js";
import {
  indexCallArgumentFor,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type { CallableContractLookup } from "./transient-contract.js";
import { projectedTypes } from "./call-resolution.js";
import { typeIsAllocationBacked } from "./reference-bearing.js";
import { typeContainsBorrowed } from "./borrowed-types.js";

type TransientIdentity = Pick<
  RuntimeIdentityGuard["left"],
  "identity" | "allocationPath"
>;

type TransientOverlap = "disjoint" | "overlap" | "uncertain";

export type RuntimeBorrowPlan = {
  guards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
  guardedPairs: ReadonlyMap<number, ReadonlySet<string>>;
  mutableStorageSymbols: ReadonlySet<SymbolId>;
};

export const transientParameterPairKey = (
  left: number,
  right: number,
): string => (left < right ? `${left}:${right}` : `${right}:${left}`);

const keyFor = (target: SymbolRef): string =>
  `${target.moduleId}:${target.symbol}`;

const contractForTarget = (
  target: SymbolRef,
  lookup: CallableContractLookup,
): CallableBorrowContract | undefined =>
  target.moduleId === lookup.localModuleId
    ? lookup.localContracts.get(target.symbol)
    : lookup.importedCallables.get(keyFor(target))?.contract;

const targetContractsForCall = (
  call: CallableBorrowIndexCall,
  lookup: CallableContractLookup,
): readonly CallableBorrowContract[] =>
  call.targets.flatMap((target) => {
    const contract = contractForTarget(target, lookup);
    return contract ? [contract] : [];
  });

const hasDynamicIndex = (path: readonly PlaceProjection[]): boolean =>
  path.some(
    (projection) =>
      projection.kind === "index" &&
      (!projection.stable || projection.constant === undefined),
  );

const compareSameRootPlaces = (
  left: readonly PlaceProjection[],
  right: readonly PlaceProjection[],
): TransientOverlap => {
  if (!projectionPathsOverlap(left, right)) return "disjoint";
  return hasDynamicIndex(left) || hasDynamicIndex(right)
    ? "uncertain"
    : "overlap";
};

const placeIdentityPath = (
  place: BorrowPlace,
  identity: TransientIdentity,
): readonly PlaceProjection[] =>
  identity.identity === "allocation"
    ? [...place.projections, ...(identity.allocationPath ?? [])]
    : place.projections;

const allocationIdentityDomain = (
  type: TypeId,
  typing: TypingResult,
): { category: "function" | "array" | "object"; nominal?: TypeId }[] => {
  const descriptor = typing.arena.get(type);
  if (descriptor.kind === "borrowed") {
    return allocationIdentityDomain(descriptor.inner, typing);
  }
  if (descriptor.kind === "recursive") {
    return allocationIdentityDomain(
      typing.arena.substitute(
        descriptor.body,
        new Map([[descriptor.binder, type]]),
      ),
      typing,
    );
  }
  if (descriptor.kind === "union") {
    return descriptor.members.flatMap((member) =>
      allocationIdentityDomain(member, typing),
    );
  }
  if (descriptor.kind === "function") return [{ category: "function" }];
  if (descriptor.kind === "fixed-array") return [{ category: "array" }];
  const nominal = typing.arena.nominalComponent(type);
  return [
    {
      category: "object",
      ...(typeof nominal === "number" ? { nominal } : {}),
    },
  ];
};

const nominalCanOverlap = (
  left: TypeId | undefined,
  right: TypeId | undefined,
  typing: TypingResult,
): boolean => {
  if (typeof left !== "number" || typeof right !== "number") return true;
  if (left === right) return true;
  const extendsNominal = (actual: TypeId, expected: TypeId): boolean => {
    const seen = new Set<TypeId>();
    let current: TypeId | undefined = actual;
    while (typeof current === "number" && !seen.has(current)) {
      if (current === expected) return true;
      seen.add(current);
      current = typing.objectsByNominal.get(current)?.baseNominal;
    }
    return false;
  };
  return extendsNominal(left, right) || extendsNominal(right, left);
};

const allocationDomainsCanOverlap = (
  left: readonly TypeId[],
  right: readonly TypeId[],
  typing: TypingResult,
): boolean =>
  left.length > 0 &&
  right.length > 0 &&
  left.some((leftType) =>
    right.some((rightType) => {
      const leftDomain = allocationIdentityDomain(leftType, typing);
      const rightDomain = allocationIdentityDomain(rightType, typing);
      return leftDomain.some((leftEntry) =>
        rightDomain.some(
          (rightEntry) =>
            leftEntry.category === rightEntry.category &&
            (leftEntry.category !== "object" ||
              nominalCanOverlap(leftEntry.nominal, rightEntry.nominal, typing)),
        ),
      );
    }),
  );

const allocationTypesFor = ({
  argument,
  identity,
  typing,
}: {
  argument: CallableBorrowIndexCall["arguments"][number];
  identity: TransientIdentity;
  typing: TypingResult;
}): readonly TypeId[] => {
  if (identity.identity !== "allocation" || typeof argument.type !== "number") {
    return [];
  }
  return identity.allocationPath && identity.allocationPath.length > 0
    ? projectedTypes(argument.type, identity.allocationPath, typing)
    : [argument.type];
};

const identityForParameter = ({
  argument,
  call,
  parameter,
  typing,
}: {
  argument: CallableBorrowIndexCall["arguments"][number];
  call: CallableBorrowIndexCall;
  parameter: CallableParameterBorrowContract;
  typing: TypingResult;
}): TransientIdentity | undefined => {
  if (!argument.place) return undefined;
  const paths = [
    ...((parameter.writePaths?.length ?? 0) > 0
      ? (parameter.writePaths ?? [])
      : (parameter.readPaths ?? [])),
  ];
  if (paths.length === 0) return undefined;
  const dereferenceStates = new Set(
    paths.map((path) =>
      path.some((projection) => projection.kind === "dereference"),
    ),
  );
  if (dereferenceStates.size !== 1) return undefined;
  if (dereferenceStates.has(true)) {
    const allocationPaths = paths.map((path) => {
      const dereference = path.findLastIndex(
        (projection) => projection.kind === "dereference",
      );
      return path.slice(0, dereference);
    });
    const firstPath = allocationPaths[0];
    if (
      !firstPath ||
      allocationPaths.some(
        (path) => JSON.stringify(path) !== JSON.stringify(firstPath),
      ) ||
      firstPath.some(
        (projection) =>
          projection.kind !== "field" &&
          projection.kind !== "tuple" &&
          projection.kind !== "dereference" &&
          projection.kind !== "identity",
      )
    ) {
      return undefined;
    }
    const projected =
      typeof argument.type === "number"
        ? projectedTypes(argument.type, firstPath, typing)
        : [];
    return projected.some((type) => typeIsAllocationBacked(type, typing))
      ? { identity: "allocation", allocationPath: firstPath }
      : undefined;
  }
  const dynamicIndexes = argument.place.projections.filter(
    (projection) =>
      projection.kind === "index" &&
      projection.stable &&
      projection.constant === undefined,
  );
  const signatureParameter = call.signature?.parameters[argument.parameter];
  if (
    signatureParameter?.bindingKind === "mutable-ref" &&
    paths.every((path) => path.length === 0) &&
    parameter.invalidatedPaths?.some((path) => path.length === 0) === true
  ) {
    const dynamicIndex = argument.place.projections.findIndex(
      (projection) =>
        projection.kind === "index" &&
        projection.stable &&
        projection.constant === undefined,
    );
    const indexedRoot =
      dynamicIndex >= 0 &&
      argument.place.projections
        .slice(dynamicIndex + 1)
        .every((projection) => projection.kind === "identity");
    const rootStorage = argument.place.projections.every(
      (projection) => projection.kind === "identity",
    );
    if (rootStorage) return { identity: "storage" };
    if (dynamicIndexes.length === 1 && indexedRoot) {
      return { identity: "indexed-place" };
    }
    return undefined;
  }
  if (
    typeof argument.type === "number" &&
    typeIsAllocationBacked(argument.type, typing)
  ) {
    return { identity: "allocation", allocationPath: [] };
  }
  return dynamicIndexes.length > 0 ? { identity: "indexed-place" } : undefined;
};

const defaultArgumentsFor = (
  call: CallableBorrowIndexCall,
): readonly number[] =>
  call.arguments.flatMap((argument) =>
    argument.defaulted ? [argument.parameter] : [],
  );

const defaultsPreserveIdentity = (
  contract: CallableBorrowContract,
  omittedParameters: readonly number[],
): boolean =>
  omittedParameters.every((parameterIndex) => {
    const parameter = contract.parameters[parameterIndex];
    return (
      parameter !== undefined &&
      parameter.defaultExternalWrite !== true &&
      (parameter.defaultWriteOrigins?.length ?? 0) === 0 &&
      (parameter.defaultExternalOrigins?.length ?? 0) === 0 &&
      (parameter.defaultExternalReturnedOrigins?.length ?? 0) === 0
    );
  });

const parameterFormsCallScopedLoan = ({
  call,
  parameter,
  parameterIndex,
  typing,
}: {
  call: CallableBorrowIndexCall;
  parameter: CallableParameterBorrowContract;
  parameterIndex: number;
  typing: TypingResult;
}): boolean => {
  const signatureParameter = call.signature?.parameters[parameterIndex];
  if (
    signatureParameter?.bindingKind === "mutable-ref" ||
    (typeof signatureParameter?.type === "number" &&
      typeContainsBorrowed(signatureParameter.type, typing))
  ) {
    return true;
  }
  return [...(parameter.readPaths ?? []), ...(parameter.writePaths ?? [])].some(
    (path) => path.some((projection) => projection.kind === "dereference"),
  );
};

const overlapForArguments = ({
  left,
  leftIdentity,
  right,
  rightIdentity,
}: {
  left: BorrowPlace;
  leftIdentity: TransientIdentity;
  right: BorrowPlace;
  rightIdentity: TransientIdentity;
}): TransientOverlap => {
  if (left.root === right.root) {
    return compareSameRootPlaces(
      placeIdentityPath(left, leftIdentity),
      placeIdentityPath(right, rightIdentity),
    );
  }
  return "uncertain";
};

const targetContractForGuard = (
  call: CallableBorrowIndexCall,
  lookup: CallableContractLookup,
): CallableBorrowContract | undefined =>
  mergeCallableBorrowContracts(
    targetContractsForCall(call, lookup).map((contract) =>
      call.traitDispatch ? (contract.dynamicDispatch ?? contract) : contract,
    ),
  );

/**
 * Plan compact identity guards for transient call sites. This planner only
 * consumes index places, types, and published contracts; it has no facts,
 * provenance, sequencing, CFG, or liveness state.
 */
export const planRuntimeBorrowing = ({
  index,
  lookup,
  typing,
}: {
  index: CallableBorrowIndex;
  lookup: CallableContractLookup;
  typing: TypingResult;
}): RuntimeBorrowPlan => {
  const guards = new Map<number, RuntimeIdentityGuard[]>();
  const guardedPairs = new Map<number, Set<string>>();
  const mutableStorageSymbols = new Set<SymbolId>(
    index.parameters.flatMap((parameter) =>
      parameter.bindingKind === "mutable-ref" ? [parameter.symbol] : [],
    ),
  );
  index.calls.forEach((call) => {
    if (call.targets.length === 0) return;
    const contract = targetContractForGuard(call, lookup);
    if (!contract) return;
    contract.parameters.forEach((parameter, parameterIndex) => {
      if (
        parameter.access !== "mutable" &&
        (parameter.writePaths?.length ?? 0) === 0
      ) {
        return;
      }
      const argument = indexCallArgumentFor(call, parameterIndex);
      if (argument?.place) mutableStorageSymbols.add(argument.place.root);
    });
    if (!callableContractAllowsRuntimeIdentityGuards(contract)) return;
    const omittedParameters = defaultArgumentsFor(call);
    if (
      omittedParameters.length > 0 &&
      (contract.defaultIdentityGuardProtocol !== "presence-conflict-bit-v1" ||
        call.traitDispatch ||
        !defaultsPreserveIdentity(contract, omittedParameters))
    ) {
      return;
    }
    const accesses = contract.parameters.flatMap((parameter, parameterIndex) =>
      parameter.readPaths?.length || parameter.writePaths?.length
        ? [{ parameter, parameterIndex }]
        : [],
    );
    for (let leftIndex = 0; leftIndex < accesses.length; leftIndex += 1) {
      const left = accesses[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < accesses.length;
        rightIndex += 1
      ) {
        const right = accesses[rightIndex]!;
        const leftWrites = (left.parameter.writePaths?.length ?? 0) > 0;
        const rightWrites = (right.parameter.writePaths?.length ?? 0) > 0;
        if (!leftWrites && !rightWrites) continue;
        if (
          !parameterFormsCallScopedLoan({
            call,
            parameter: left.parameter,
            parameterIndex: left.parameterIndex,
            typing,
          }) ||
          !parameterFormsCallScopedLoan({
            call,
            parameter: right.parameter,
            parameterIndex: right.parameterIndex,
            typing,
          })
        ) {
          continue;
        }
        if (
          runtimeIdentityGuardParameterCanEscape(left.parameter) ||
          runtimeIdentityGuardParameterCanEscape(right.parameter)
        ) {
          continue;
        }
        const leftArgument = indexCallArgumentFor(call, left.parameterIndex);
        const rightArgument = indexCallArgumentFor(call, right.parameterIndex);
        if (!leftArgument?.place || !rightArgument?.place) continue;
        const leftIdentity = identityForParameter({
          argument: leftArgument,
          call,
          parameter: left.parameter,
          typing,
        });
        const rightIdentity = identityForParameter({
          argument: rightArgument,
          call,
          parameter: right.parameter,
          typing,
        });
        if (!leftIdentity || !rightIdentity) continue;
        const identityUsesRootAllocation = (
          identity: TransientIdentity,
        ): boolean =>
          identity.identity === "allocation" &&
          (identity.allocationPath?.length ?? 0) === 0;
        const definitelyDistinctFreshRoot =
          leftArgument.place.root !== rightArgument.place.root &&
          identityUsesRootAllocation(leftIdentity) &&
          identityUsesRootAllocation(rightIdentity) &&
          (leftArgument.fresh === true || rightArgument.fresh === true);
        const overlap = definitelyDistinctFreshRoot
          ? "disjoint"
          : overlapForArguments({
              left: leftArgument.place,
              leftIdentity,
              right: rightArgument.place,
              rightIdentity,
            });
        if (overlap !== "uncertain") continue;
        if (
          leftIdentity.identity === "allocation" &&
          rightIdentity.identity === "allocation" &&
          !allocationDomainsCanOverlap(
            allocationTypesFor({
              argument: leftArgument,
              identity: leftIdentity,
              typing,
            }),
            allocationTypesFor({
              argument: rightArgument,
              identity: rightIdentity,
              typing,
            }),
            typing,
          )
        ) {
          continue;
        }
        const leftExpression = leftArgument.expression;
        const rightExpression = rightArgument.expression;
        if (
          typeof leftExpression !== "number" ||
          typeof rightExpression !== "number"
        ) {
          continue;
        }
        const pair = transientParameterPairKey(
          left.parameterIndex,
          right.parameterIndex,
        );
        const guard: RuntimeIdentityGuard = {
          call: call.exprId,
          target: call.targets[0]!,
          left: {
            parameter: left.parameterIndex,
            expression: leftExpression,
            place: leftArgument.place,
            display: `argument ${left.parameterIndex + 1}`,
            ...leftIdentity,
          },
          right: {
            parameter: right.parameterIndex,
            expression: rightExpression,
            place: rightArgument.place,
            display: `argument ${right.parameterIndex + 1}`,
            ...rightIdentity,
          },
          ...(omittedParameters.length > 0
            ? {
                afterDefaults: true as const,
                defaultIdentityGuardProtocol:
                  "presence-conflict-bit-v1" as const,
                omittedParameters,
              }
            : {}),
        };
        const callGuards = guards.get(call.exprId) ?? [];
        if (
          !callGuards.some(
            (candidate) =>
              transientParameterPairKey(
                candidate.left.parameter,
                candidate.right.parameter,
              ) === pair,
          )
        ) {
          callGuards.push(guard);
          guards.set(call.exprId, callGuards);
        }
        const pairs = guardedPairs.get(call.exprId) ?? new Set<string>();
        pairs.add(pair);
        guardedPairs.set(call.exprId, pairs);
      }
    }
  });
  return { guards, guardedPairs, mutableStorageSymbols };
};
