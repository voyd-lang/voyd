import {
  diagnosticFromCode,
  type Diagnostic,
} from "../../diagnostics/index.js";
import type { SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { projectedTypes } from "./call-resolution.js";
import {
  indexCallArgumentFor,
  type CallableBorrowIndex,
  type CallableBorrowIndexArgument,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type {
  BorrowPlace,
  PlaceProjection,
  RuntimeIdentityGuard,
} from "./model.js";
import { projectionPathsOverlap } from "./model.js";
import {
  joinOrdinaryMutationSummaries,
  OrdinaryParameterAccess,
  ordinaryMutationSignatureUpperBound,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";
import {
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { OrdinaryIdentityGuardRejectionReason } from "../../perf-counter-schema.js";
import type { SymbolTable } from "../binder/index.js";

type OrdinaryIdentity = Pick<
  RuntimeIdentityGuard["left"],
  "identity" | "allocationPath"
>;

type OrdinaryAccess = {
  parameter: number;
  access: OrdinaryParameterAccess;
  argument: CallableBorrowIndexArgument;
  argumentRootIsParameter: boolean;
  /** Direct local body paths. Absent when a call crosses a finite boundary. */
  localPaths?: readonly (readonly PlaceProjection[])[];
  localRootRebound?: true;
};

type OrdinaryAccessComparison =
  | { kind: "disjoint" }
  | { kind: "overlap"; reason: OrdinaryIdentityGuardRejectionReason }
  | { kind: "guard"; guards: readonly RuntimeIdentityGuard[] };

export type OrdinaryMutationSafetyPlan = {
  guards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
  mutableStorageSymbols: ReadonlySet<SymbolId>;
  diagnostics: readonly Diagnostic[];
};

/**
 * Enforce whole-parameter ordinary call access without reconstructing a
 * path-sensitive callable contract. Local places remain precise only while
 * comparing the arguments of the current call.
 */
export const planOrdinaryMutationSafety = ({
  index,
  moduleId,
  localSummaries,
  localIndexes,
  importedSummaries,
  defaultIdentityGuardTargets,
  typing,
  symbolTable,
}: {
  index: CallableBorrowIndex;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  localIndexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
  /** Module-qualified targets that implement the deferred-default guard ABI. */
  defaultIdentityGuardTargets: ReadonlySet<string>;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): OrdinaryMutationSafetyPlan => {
  const guards = new Map<number, RuntimeIdentityGuard[]>();
  const localRootReboundParameters = createLocalRootReboundParameterResolver({
    localIndexes,
    moduleId,
  });
  const mutableStorageSymbols = new Set<SymbolId>([
    ...index.mutableAliasSourceRoots,
    ...index.parameters.flatMap((parameter) =>
      parameter.bindingKind === "mutable-ref" ? [parameter.symbol] : [],
    ),
  ]);
  const diagnostics: Diagnostic[] = [];

  index.calls.forEach((call) => {
    const summary = summaryForCall({
      call,
      moduleId,
      localSummaries,
      importedSummaries,
    });
    if (!summary) return;
    const accesses = callAccesses({
      call,
      summary,
      caller: index,
      localIndexes,
      moduleId,
      typing,
      localRootReboundParameters,
    });
    accesses
      .filter((entry) => entry.access === OrdinaryParameterAccess.Write)
      .forEach((entry) => {
        if (entry.argument.place) {
          mutableStorageSymbols.add(entry.argument.place.root);
        }
      });

    for (let leftIndex = 0; leftIndex < accesses.length; leftIndex += 1) {
      const left = accesses[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < accesses.length;
        rightIndex += 1
      ) {
        const right = accesses[rightIndex]!;
        if (
          left.access !== OrdinaryParameterAccess.Write &&
          right.access !== OrdinaryParameterAccess.Write
        ) {
          continue;
        }
        const outcome = compareCallAccesses({
          left,
          right,
          call,
          summary,
          defaultIdentityGuardTargets,
          typing,
          symbolTable,
        });
        incrementCompilerPerfCounter("borrowing.identity_guard.pairs");
        if (outcome.kind === "disjoint") {
          incrementCompilerPerfCounter(
            "borrowing.identity_guard.static_disjoint",
          );
          continue;
        }
        if (outcome.kind === "guard") {
          incrementCompilerPerfCounter(
            outcome.guards.some((guard) => guard.afterDefaults)
              ? "borrowing.identity_guard.emitted.deferred_default"
              : "borrowing.identity_guard.emitted.immediate",
            outcome.guards.length,
          );
          const existing = guards.get(call.exprId) ?? [];
          outcome.guards.forEach((guard) => {
            if (!existing.some((candidate) => sameGuard(candidate, guard))) {
              existing.push(guard);
            }
          });
          guards.set(call.exprId, existing);
          continue;
        }
        incrementCompilerPerfCounter(
          `borrowing.identity_guard.rejected.${outcome.reason}`,
        );
        diagnostics.push(overlapDiagnostic({ index, call, left, right }));
        break;
      }
      if (diagnostics.at(-1)?.span.start === call.span.start) break;
    }
  });

  return { guards, mutableStorageSymbols, diagnostics };
};

const importedKey = ({ moduleId, symbol }: SymbolRef): string =>
  `${moduleId}::${symbol}`;

const summaryForCall = ({
  call,
  moduleId,
  localSummaries,
  importedSummaries,
}: {
  call: CallableBorrowIndexCall;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
}): OrdinaryMutationSummary | undefined => {
  if (call.intrinsic || call.ordinaryMutationFreeConstruction === true) {
    return undefined;
  }
  if (call.ordinaryDynamicBound) {
    return {
      parameterAccesses: call.ordinaryDynamicBound.parameterBindingKinds.map(
        (kind) =>
          kind === "mutable-ref"
            ? OrdinaryParameterAccess.Write
            : OrdinaryParameterAccess.Read,
      ),
      ambientObjectAccess: call.ordinaryDynamicBound.ambientObjectAccess,
      invokesUnknownCallback: call.ordinaryDynamicBound.invokesUnknownCallback,
      maySuspend: call.ordinaryDynamicBound.maySuspend,
    };
  }
  if (call.openTraitDispatch && call.signature) {
    return {
      ...ordinaryMutationSignatureUpperBound({ signature: call.signature }),
      ambientObjectAccess: true,
      invokesUnknownCallback: true,
      maySuspend: true,
    };
  }
  const targetSummaries = call.targets.flatMap((target) => {
    const summary =
      target.moduleId === moduleId
        ? localSummaries.get(target.symbol)
        : importedSummaries.get(importedKey(target));
    return summary ? [summary] : [];
  });
  const resolved = targetSummaries.reduce<OrdinaryMutationSummary | undefined>(
    (current, summary) =>
      current ? joinOrdinaryMutationSummaries(current, summary) : summary,
    undefined,
  );
  if (
    resolved &&
    targetSummaries.length === call.targets.length &&
    call.argumentPlanAmbiguous !== true
  ) {
    return resolved;
  }
  const fallback = call.signature
    ? ordinaryMutationSignatureUpperBound({
        signature: call.signature,
        maySuspend: call.maySuspend,
      })
    : undefined;
  return resolved && fallback
    ? joinOrdinaryMutationSummaries(resolved, fallback)
    : (resolved ?? fallback);
};

const callAccesses = ({
  call,
  summary,
  caller,
  localIndexes,
  moduleId,
  typing,
  localRootReboundParameters,
}: {
  call: CallableBorrowIndexCall;
  summary: OrdinaryMutationSummary;
  caller: CallableBorrowIndex;
  localIndexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  moduleId: string;
  typing: TypingResult;
  localRootReboundParameters: (
    call: CallableBorrowIndexCall,
  ) => ReadonlySet<number>;
}): readonly OrdinaryAccess[] => {
  const localPaths = directLocalPathsForCall({
    call,
    localIndexes,
    moduleId,
    typing,
  });
  const reboundParameters = localRootReboundParameters(call);
  const parameterCount = Math.max(
    summary.parameterAccesses.length,
    call.signature?.parameters.length ?? 0,
  );
  return Array.from({ length: parameterCount }).flatMap((_, parameter) => {
    const summarized =
      summary.parameterAccesses[parameter] ?? OrdinaryParameterAccess.Unused;
    const signatureParameter = call.signature?.parameters[parameter];
    const signatureType = signatureParameter?.type;
    const explicitlyBorrowed =
      typeof signatureType === "number" &&
      typing.arena.get(typing.arena.unfoldRecursive(signatureType)).kind ===
        "borrowed";
    const forced = explicitlyBorrowed
      ? signatureParameter?.bindingKind === "mutable-ref"
        ? OrdinaryParameterAccess.Write
        : OrdinaryParameterAccess.Read
      : OrdinaryParameterAccess.Unused;
    const access = Math.max(summarized, forced) as OrdinaryParameterAccess;
    if (access === OrdinaryParameterAccess.Unused) return [];
    const argument = indexCallArgumentFor(call, parameter);
    if (!argument?.place) return [];
    if (
      access === OrdinaryParameterAccess.Read &&
      !argumentCanAliasDuringCall({ argument, call, parameter, typing })
    ) {
      return [];
    }
    const paths = localPaths?.get(parameter);
    const localAccessPaths =
      access === OrdinaryParameterAccess.Write ? paths?.write : paths?.read;
    return [
      {
        parameter,
        access,
        argument,
        argumentRootIsParameter: caller.parameterPlaces.has(
          argument.place.root,
        ),
        ...(localAccessPaths && localAccessPaths.length > 0
          ? { localPaths: localAccessPaths }
          : {}),
        ...(reboundParameters.has(parameter)
          ? { localRootRebound: true as const }
          : {}),
      },
    ];
  });
};

type DirectLocalPaths = {
  read: readonly (readonly PlaceProjection[])[];
  write: readonly (readonly PlaceProjection[])[];
};

const directLocalPathsForCall = ({
  call,
  localIndexes,
  moduleId,
  typing,
}: {
  call: CallableBorrowIndexCall;
  localIndexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  moduleId: string;
  typing: TypingResult;
}): ReadonlyMap<number, DirectLocalPaths> | undefined => {
  if (
    call.openTraitDispatch ||
    call.argumentPlanAmbiguous ||
    call.targets.length !== 1 ||
    call.targets[0]?.moduleId !== moduleId
  ) {
    return undefined;
  }
  const target = localIndexes.get(call.targets[0].symbol);
  if (!target || target.calls.some((candidate) => !candidate.intrinsic)) {
    return undefined;
  }
  const paths = new Map<
    number,
    { read: PlaceProjection[][]; write: PlaceProjection[][] }
  >();
  target.accesses.forEach((access) => {
    if (!access.place) return;
    const source = target.parameterPlaces.get(access.place.root);
    if (!source) return;
    const entries = paths.get(source.parameter) ?? { read: [], write: [] };
    const parameter = target.parameters[source.parameter];
    const implicitAllocationDereference =
      access.place.projections.length > 0 &&
      typeof parameter?.type === "number" &&
      typeIsAllocationBacked(parameter.type, typing) &&
      access.place.projections[0]?.kind !== "dereference";
    const path = [
      ...source.path,
      ...(implicitAllocationDereference
        ? ([{ kind: "dereference" }] as const)
        : []),
      ...access.place.projections,
    ];
    const destination = access.kind === "write" ? entries.write : entries.read;
    if (
      !destination.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(path),
      )
    ) {
      destination.push(path);
    }
    paths.set(source.parameter, entries);
  });
  target.calls
    .filter(
      (candidate) =>
        candidate.intrinsic && candidate.intrinsicName === "__array_get",
    )
    .forEach((candidate) => {
      const argument = indexCallArgumentFor(candidate, 0);
      if (!argument?.place) return;
      const source = target.parameterPlaces.get(argument.place.root);
      if (!source) return;
      const entries = paths.get(source.parameter) ?? { read: [], write: [] };
      const path = [
        ...source.path,
        ...argument.place.projections,
        { kind: "dereference" } as const,
        ...(candidate.intrinsicIndex ? [candidate.intrinsicIndex] : []),
        { kind: "dereference" } as const,
      ];
      if (
        !entries.read.some(
          (candidatePath) =>
            JSON.stringify(candidatePath) === JSON.stringify(path),
        )
      ) {
        entries.read.push(path);
      }
      paths.set(source.parameter, entries);
    });
  return new Map(
    Array.from(paths, ([parameter, entries]) => {
      const parameterType = target.parameters[parameter]?.type;
      if (
        typeof parameterType !== "number" ||
        !typeIsAllocationBacked(parameterType, typing)
      ) {
        return [parameter, entries] as const;
      }
      const nested = entries.read.filter((path) =>
        path.some((projection) => projection.kind === "dereference"),
      );
      return [
        parameter,
        {
          ...entries,
          read: nested.length > 0 ? nested : entries.read,
        },
      ] as const;
    }),
  );
};

const createLocalRootReboundParameterResolver = ({
  localIndexes,
  moduleId,
}: {
  localIndexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  moduleId: string;
}): ((call: CallableBorrowIndexCall) => ReadonlySet<number>) => {
  const cache = new Map<SymbolId, ReadonlySet<number>>();
  // A local callable's rebound result is independent of its call site. Cache
  // cycle-free results so a branching call graph is visited once per planner
  // invocation. Results cut off by the active-cycle guard remain contextual
  // and must not be reused from another traversal root.
  const resolveCall = (
    call: CallableBorrowIndexCall,
    active: ReadonlySet<SymbolId> = new Set(),
  ): {
    parameters: ReadonlySet<number>;
    cacheable: boolean;
  } => {
    if (
      call.openTraitDispatch ||
      call.argumentPlanAmbiguous ||
      call.targets.length !== 1 ||
      call.targets[0]?.moduleId !== moduleId
    ) {
      return { parameters: new Set(), cacheable: true };
    }
    const target = localIndexes.get(call.targets[0].symbol);
    if (!target) return { parameters: new Set(), cacheable: true };
    if (active.has(target.symbol)) {
      return { parameters: new Set(), cacheable: false };
    }
    const cached = cache.get(target.symbol);
    if (cached) return { parameters: cached, cacheable: true };
    const nextActive = new Set(active).add(target.symbol);
    const rebound = new Set(target.rootReboundParameters);
    const disqualified = new Set<number>();
    let cacheable = true;

    target.accesses
      .filter((access) => access.kind === "write" && access.place !== undefined)
      .forEach((access) => {
        const source = target.parameterPlaces.get(access.place!.root);
        if (!source) return;
        const path = [...source.path, ...access.place!.projections];
        if (path.every((projection) => projection.kind === "identity")) {
          rebound.add(source.parameter);
          return;
        }
        disqualified.add(source.parameter);
      });

    target.calls
      .filter((nested) => !nested.intrinsic)
      .forEach((nested) => {
        const nestedResolution = resolveCall(nested, nextActive);
        cacheable &&= nestedResolution.cacheable;
        nested.arguments.forEach((argument) => {
          const bindingKind =
            nested.signature?.parameters[argument.parameter]?.bindingKind ??
            argument.bindingKind;
          if (bindingKind !== "mutable-ref" || !argument.place) return;
          const source = target.parameterPlaces.get(argument.place.root);
          if (!source) return;
          const path = [...source.path, ...argument.place.projections];
          if (
            nestedResolution.parameters.has(argument.parameter) &&
            path.every((projection) => projection.kind === "identity")
          ) {
            rebound.add(source.parameter);
            return;
          }
          disqualified.add(source.parameter);
        });
      });

    disqualified.forEach((parameter) => rebound.delete(parameter));
    if (cacheable) cache.set(target.symbol, rebound);
    return { parameters: rebound, cacheable };
  };
  return (call) => resolveCall(call).parameters;
};

const argumentCanAliasDuringCall = ({
  argument,
  call,
  parameter,
  typing,
}: {
  argument: CallableBorrowIndexArgument;
  call: CallableBorrowIndexCall;
  parameter: number;
  typing: TypingResult;
}): boolean => {
  const bindingKind =
    call.signature?.parameters[parameter]?.bindingKind ?? argument.bindingKind;
  if (bindingKind === "mutable-ref" || bindingKind === "immutable-ref") {
    return true;
  }
  return (
    argument.loanBearing === true ||
    argument.referenceCapable === true ||
    (typeof argument.type === "number" &&
      typeCanCarryReference(argument.type, typing))
  );
};

const hasDynamicIndex = (path: readonly PlaceProjection[]): boolean =>
  path.some(
    (projection) =>
      projection.kind === "index" &&
      (!projection.stable || projection.constant === undefined),
  );

const compareSameRoot = (
  left: BorrowPlace,
  right: BorrowPlace,
): "disjoint" | "overlap" | "uncertain" => {
  if (!projectionPathsOverlap(left.projections, right.projections)) {
    return "disjoint";
  }
  return hasDynamicIndex(left.projections) || hasDynamicIndex(right.projections)
    ? "uncertain"
    : "overlap";
};

const storageIdentityForPlace = (
  place: BorrowPlace,
): OrdinaryIdentity | undefined => {
  if (place.projections.every((projection) => projection.kind === "identity")) {
    return { identity: "storage" };
  }
  const indexes = place.projections
    .map((projection, index) => ({ projection, index }))
    .filter(({ projection }) => projection.kind === "index");
  if (indexes.length !== 1) return undefined;
  const indexed = indexes[0]!;
  return indexed.projection.kind === "index" &&
    indexed.projection.stable &&
    place.projections
      .slice(indexed.index + 1)
      .every((projection) => projection.kind === "identity")
    ? { identity: "indexed-place" }
    : undefined;
};

const identityForLocalPath = ({
  access,
  path,
  call,
  typing,
}: {
  access: OrdinaryAccess;
  path: readonly PlaceProjection[];
  call: CallableBorrowIndexCall;
  typing: TypingResult;
}): OrdinaryIdentity | undefined => {
  const { argument, parameter } = access;
  if (!argument.place) return undefined;
  if (path.length === 0) {
    return (call.signature?.parameters[parameter]?.bindingKind ??
      argument.bindingKind) === "mutable-ref" &&
      access.localRootRebound === true
      ? storageIdentityForPlace(argument.place)
      : undefined;
  }
  const dereference = path.findLastIndex(
    (projection) => projection.kind === "dereference",
  );
  if (dereference >= 0) {
    const allocationPath = path.slice(0, dereference);
    if (
      allocationPath.some(
        (projection) =>
          projection.kind !== "field" &&
          projection.kind !== "tuple" &&
          projection.kind !== "identity" &&
          projection.kind !== "dereference",
      )
    ) {
      return undefined;
    }
    const projected =
      typeof argument.type === "number"
        ? projectedTypes(argument.type, allocationPath, typing)
        : [];
    return projected.some((type) => typeIsAllocationBacked(type, typing))
      ? { identity: "allocation", allocationPath }
      : undefined;
  }
  if (
    typeof argument.type === "number" &&
    typeIsAllocationBacked(argument.type, typing)
  ) {
    return { identity: "allocation", allocationPath: [] };
  }
  return storageIdentityForPlace(argument.place);
};

const fallbackIdentityForArgument = ({
  access,
  call,
  typing,
}: {
  access: OrdinaryAccess;
  call: CallableBorrowIndexCall;
  typing: TypingResult;
}): OrdinaryIdentity | undefined => {
  const { argument, parameter } = access;
  if (!argument.place) return undefined;
  const placeIdentity = storageIdentityForPlace(argument.place);
  if (placeIdentity?.identity === "indexed-place") return placeIdentity;
  const bindingKind =
    call.signature?.parameters[parameter]?.bindingKind ?? argument.bindingKind;
  const typeKind =
    typeof argument.type === "number"
      ? typing.arena.get(typing.arena.unfoldRecursive(argument.type)).kind
      : undefined;
  if (bindingKind === "mutable-ref" && access.localRootRebound === true) {
    return storageIdentityForPlace(argument.place);
  }
  if (
    typeKind !== "type-param-ref" &&
    typeof argument.type === "number" &&
    typeIsAllocationBacked(argument.type, typing)
  ) {
    return { identity: "allocation", allocationPath: [] };
  }
  if (bindingKind === "mutable-ref") {
    return storageIdentityForPlace(argument.place);
  }
  return typeKind === "type-param-ref"
    ? storageIdentityForPlace(argument.place)
    : undefined;
};

const identitiesForAccess = ({
  access,
  call,
  typing,
}: {
  access: OrdinaryAccess;
  call: CallableBorrowIndexCall;
  typing: TypingResult;
}): { identities: readonly OrdinaryIdentity[]; complete: boolean } => {
  const placeIdentity = access.argument.place
    ? storageIdentityForPlace(access.argument.place)
    : undefined;
  const dynamicIndexedPlace =
    placeIdentity?.identity === "indexed-place" &&
    hasDynamicIndex(access.argument.place!.projections);
  const candidates =
    dynamicIndexedPlace && access.localPaths === undefined
      ? [placeIdentity]
      : access.localPaths
        ? access.localPaths.map((path) =>
            identityForLocalPath({ access, path, call, typing }),
          )
        : [fallbackIdentityForArgument({ access, call, typing })];
  return {
    identities: Array.from(
      new Map(
        candidates.flatMap((identity) =>
          identity ? [[JSON.stringify(identity), identity] as const] : [],
        ),
      ).values(),
    ),
    complete: candidates.every((identity) => identity !== undefined),
  };
};

const allocationTypesCanOverlap = (
  left: TypeId | undefined,
  right: TypeId | undefined,
  typing: TypingResult,
): boolean => {
  if (typeof left !== "number" || typeof right !== "number") return true;
  const leftNominal = typing.arena.nominalComponent(left);
  const rightNominal = typing.arena.nominalComponent(right);
  if (leftNominal === undefined || rightNominal === undefined) {
    const leftKind = typing.arena.get(left).kind;
    const rightKind = typing.arena.get(right).kind;
    if (leftKind === "fixed-array" || rightKind === "fixed-array") {
      return leftKind === "fixed-array" && rightKind === "fixed-array";
    }
    return true;
  }
  if (leftNominal === rightNominal) return true;
  const derivesFrom = (actual: TypeId, expected: TypeId): boolean => {
    const seen = new Set<TypeId>();
    let current: TypeId | undefined = actual;
    while (typeof current === "number" && !seen.has(current)) {
      if (current === expected) return true;
      seen.add(current);
      current = typing.objectsByNominal.get(current)?.baseNominal;
    }
    return false;
  };
  return (
    derivesFrom(leftNominal, rightNominal) ||
    derivesFrom(rightNominal, leftNominal)
  );
};

const allocationTypesFor = (
  access: OrdinaryAccess,
  identity: OrdinaryIdentity,
  typing: TypingResult,
): readonly TypeId[] => {
  if (
    identity.identity !== "allocation" ||
    typeof access.argument.type !== "number"
  ) {
    return [];
  }
  return projectedTypes(
    access.argument.type,
    identity.allocationPath ?? [],
    typing,
  );
};

const allocationDomainsCanOverlap = ({
  left,
  leftIdentity,
  right,
  rightIdentity,
  typing,
}: {
  left: OrdinaryAccess;
  leftIdentity: OrdinaryIdentity;
  right: OrdinaryAccess;
  rightIdentity: OrdinaryIdentity;
  typing: TypingResult;
}): boolean => {
  const leftTypes = allocationTypesFor(left, leftIdentity, typing);
  const rightTypes = allocationTypesFor(right, rightIdentity, typing);
  return (
    leftTypes.length === 0 ||
    rightTypes.length === 0 ||
    leftTypes.some((leftType) =>
      rightTypes.some((rightType) =>
        allocationTypesCanOverlap(leftType, rightType, typing),
      ),
    )
  );
};

type AllocationTypeDomain = {
  types: readonly TypeId[];
  complete: boolean;
};

const MAX_ALLOCATION_TYPE_DOMAIN_VISITS = 512;
const allocationTypeDomainsByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, AllocationTypeDomain>
>();

/**
 * Collect the first allocation identity on each path through an inline value.
 * Nominal objects stop the walk because `~obj` covers that allocation, not the
 * complete graph reachable from its fields. Structural and value aggregates
 * are copied inline, so their object-bearing fields remain relevant aliases.
 */
const allocationTypeDomainFor = (
  type: TypeId,
  typing: TypingResult,
): AllocationTypeDomain => {
  const cache = allocationTypeDomainsByTyping.get(typing) ?? new Map();
  allocationTypeDomainsByTyping.set(typing, cache);
  const cached = cache.get(type);
  if (cached) return cached;

  const collect = (
    current: TypeId,
    active: ReadonlySet<TypeId>,
    budget: { remaining: number },
  ): AllocationTypeDomain => {
    budget.remaining -= 1;
    if (budget.remaining < 0 || active.has(current)) {
      return { types: [], complete: false };
    }
    const descriptor = typing.arena.get(current);
    const nextActive = new Set(active).add(current);
    const collectMembers = (
      members: readonly TypeId[],
    ): AllocationTypeDomain => {
      const domains = members.map((member) =>
        collect(member, nextActive, budget),
      );
      return {
        types: Array.from(new Set(domains.flatMap((domain) => domain.types))),
        complete: domains.every((domain) => domain.complete),
      };
    };
    const collectFields = (
      fields: readonly { type: TypeId }[] | undefined,
    ): AllocationTypeDomain =>
      fields
        ? collectMembers(fields.map((field) => field.type))
        : { types: [], complete: false };

    switch (descriptor.kind) {
      case "primitive":
        return { types: [], complete: true };
      case "borrowed":
        return collect(descriptor.inner, nextActive, budget);
      case "nominal-object":
      case "trait":
      case "fixed-array":
      case "function":
        return { types: [current], complete: true };
      case "type-param-ref":
        return { types: [], complete: false };
      case "value-object":
        return collectFields(typing.objectsByNominal.get(current)?.fields);
      case "structural-object":
        return collectFields(descriptor.fields);
      case "recursive":
        return collect(descriptor.body, nextActive, budget);
      case "union":
        return collectMembers(descriptor.members);
      case "intersection": {
        if (typeof descriptor.nominal === "number") {
          const nominal = typing.arena.get(descriptor.nominal);
          return nominal.kind === "value-object"
            ? collect(descriptor.nominal, nextActive, budget)
            : { types: [current], complete: true };
        }
        if (typeof descriptor.structural === "number") {
          return collect(descriptor.structural, nextActive, budget);
        }
        return (descriptor.traits?.length ?? 0) > 0
          ? { types: [current], complete: true }
          : { types: [], complete: false };
      }
    }
  };

  const domain = collect(type, new Set(), {
    remaining: MAX_ALLOCATION_TYPE_DOMAIN_VISITS,
  });
  cache.set(type, domain);
  return domain;
};

const accessAllocationDomainsAreDisjoint = (
  left: OrdinaryAccess,
  right: OrdinaryAccess,
  typing: TypingResult,
): boolean => {
  const leftType = left.argument.type;
  const rightType = right.argument.type;
  if (typeof leftType !== "number" || typeof rightType !== "number") {
    return false;
  }
  const leftDomain = allocationTypeDomainFor(leftType, typing);
  const rightDomain = allocationTypeDomainFor(rightType, typing);
  if (!leftDomain.complete || !rightDomain.complete) return false;
  if (leftDomain.types.length === 0 && rightDomain.types.length === 0) {
    return false;
  }
  return leftDomain.types.every((leftAllocation) =>
    rightDomain.types.every(
      (rightAllocation) =>
        !allocationTypesCanOverlap(leftAllocation, rightAllocation, typing),
    ),
  );
};

type IdentityOverlap = "disjoint" | "overlap" | "uncertain";

const allocationIdentitySourcePath = (
  access: OrdinaryAccess,
  identity: OrdinaryIdentity,
): readonly PlaceProjection[] => [
  ...access.argument.place!.projections,
  ...(identity.allocationPath ?? []),
];

const compareIdentityPair = ({
  left,
  leftIdentity,
  right,
  rightIdentity,
  typing,
}: {
  left: OrdinaryAccess;
  leftIdentity: OrdinaryIdentity;
  right: OrdinaryAccess;
  rightIdentity: OrdinaryIdentity;
  typing: TypingResult;
}): IdentityOverlap => {
  const leftPlace = left.argument.place!;
  const rightPlace = right.argument.place!;
  if (
    leftIdentity.identity === "allocation" &&
    rightIdentity.identity === "allocation"
  ) {
    if (
      !allocationDomainsCanOverlap({
        left,
        leftIdentity,
        right,
        rightIdentity,
        typing,
      })
    ) {
      return "disjoint";
    }
    if (
      leftPlace.root !== rightPlace.root &&
      (leftIdentity.allocationPath?.length ?? 0) === 0 &&
      (rightIdentity.allocationPath?.length ?? 0) === 0 &&
      (left.argument.fresh === true || right.argument.fresh === true)
    ) {
      return "disjoint";
    }
    const leftSource = allocationIdentitySourcePath(left, leftIdentity);
    const rightSource = allocationIdentitySourcePath(right, rightIdentity);
    if (
      leftPlace.root === rightPlace.root &&
      !hasDynamicIndex(leftPlace.projections) &&
      !hasDynamicIndex(rightPlace.projections) &&
      !projectionPathsOverlap(leftPlace.projections, rightPlace.projections) &&
      (leftIdentity.allocationPath?.length ?? 0) === 0 &&
      (rightIdentity.allocationPath?.length ?? 0) === 0
    ) {
      return "disjoint";
    }
    if (
      leftPlace.root === rightPlace.root &&
      left.argument.provenanceFreeFresh === true &&
      right.argument.provenanceFreeFresh === true &&
      !hasDynamicIndex(leftSource) &&
      !hasDynamicIndex(rightSource) &&
      !projectionPathsOverlap(leftSource, rightSource)
    ) {
      return "disjoint";
    }
    return leftPlace.root === rightPlace.root &&
      !hasDynamicIndex(leftSource) &&
      !hasDynamicIndex(rightSource) &&
      JSON.stringify(leftSource) === JSON.stringify(rightSource)
      ? "overlap"
      : "uncertain";
  }
  if (leftIdentity.identity !== rightIdentity.identity) return "disjoint";
  if (leftIdentity.identity === "storage") {
    if (leftPlace.root === rightPlace.root) {
      return compareSameRoot(leftPlace, rightPlace);
    }
    return left.argumentRootIsParameter || right.argumentRootIsParameter
      ? "uncertain"
      : "disjoint";
  }
  return leftPlace.root === rightPlace.root
    ? compareSameRoot(leftPlace, rightPlace)
    : "uncertain";
};

const compareCallAccesses = ({
  left,
  right,
  call,
  summary,
  defaultIdentityGuardTargets,
  typing,
  symbolTable,
}: {
  left: OrdinaryAccess;
  right: OrdinaryAccess;
  call: CallableBorrowIndexCall;
  summary: OrdinaryMutationSummary;
  defaultIdentityGuardTargets: ReadonlySet<string>;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): OrdinaryAccessComparison => {
  const leftPlace = left.argument.place!;
  const rightPlace = right.argument.place!;
  if (
    leftPlace.root !== rightPlace.root &&
    (left.argument.fresh === true || right.argument.fresh === true) &&
    freshOuterIdentityIsAccessed(left, typing) &&
    freshOuterIdentityIsAccessed(right, typing)
  ) {
    return { kind: "disjoint" };
  }
  if (
    leftPlace.root === rightPlace.root &&
    compareSameRoot(leftPlace, rightPlace) === "overlap"
  ) {
    return { kind: "overlap", reason: "same-place-overlap" };
  }
  const leftIdentities = identitiesForAccess({ access: left, call, typing });
  const rightIdentities = identitiesForAccess({ access: right, call, typing });
  if (!leftIdentities.complete || !rightIdentities.complete) {
    if (accessAllocationDomainsAreDisjoint(left, right, typing)) {
      return { kind: "disjoint" };
    }
    return { kind: "overlap", reason: "incomplete-identity" };
  }
  const pairs = leftIdentities.identities.flatMap((leftIdentity) =>
    rightIdentities.identities.map((rightIdentity) => ({
      leftIdentity,
      rightIdentity,
      overlap: compareIdentityPair({
        left,
        leftIdentity,
        right,
        rightIdentity,
        typing,
      }),
    })),
  );
  if (pairs.some((pair) => pair.overlap === "overlap")) {
    return { kind: "overlap", reason: "proven-overlap" };
  }
  const uncertainPairs = pairs.filter((pair) => pair.overlap === "uncertain");
  if (uncertainPairs.length === 0) return { kind: "disjoint" };
  const omittedParameters = Array.from(
    new Set(
      call.arguments.flatMap((argument) =>
        argument.defaulted ? [argument.parameter] : [],
      ),
    ),
  ).sort((leftParameter, rightParameter) => leftParameter - rightParameter);
  const target = call.targets.length === 1 ? call.targets[0] : undefined;
  const omittedDefaultsAreGuardable =
    omittedParameters.length === 0 ||
    (target !== undefined &&
      defaultIdentityGuardTargets.has(importedKey(target)));
  if (summary.maySuspend) {
    return { kind: "overlap", reason: "suspending-target" };
  }
  if (summary.ambientObjectAccess) {
    return { kind: "overlap", reason: "ambient-access" };
  }
  if (summary.invokesUnknownCallback) {
    return { kind: "overlap", reason: "unknown-callback" };
  }
  if (target === undefined) {
    return { kind: "overlap", reason: "unresolved-target" };
  }
  if (!omittedDefaultsAreGuardable) {
    return { kind: "overlap", reason: "unguardable-default" };
  }
  const leftExpression = left.argument.expression;
  const rightExpression = right.argument.expression;
  if (
    typeof leftExpression !== "number" ||
    typeof rightExpression !== "number"
  ) {
    return { kind: "overlap", reason: "missing-expression" };
  }
  return {
    kind: "guard",
    guards: uncertainPairs.map(({ leftIdentity, rightIdentity }) => ({
      call: call.exprId,
      target,
      left: {
        parameter: left.parameter,
        expression: leftExpression,
        place: leftPlace,
        display: guardOperandDisplay({ access: left, symbolTable }),
        ...leftIdentity,
      },
      right: {
        parameter: right.parameter,
        expression: rightExpression,
        place: rightPlace,
        display: guardOperandDisplay({ access: right, symbolTable }),
        ...rightIdentity,
      },
      ...(omittedParameters.length > 0
        ? {
            afterDefaults: true as const,
            defaultIdentityGuardProtocol: "presence-conflict-bit-v1" as const,
            omittedParameters,
          }
        : {}),
    })),
  };
};

const freshOuterIdentityIsAccessed = (
  access: OrdinaryAccess,
  typing: TypingResult,
): boolean => {
  const type = access.argument.type;
  if (typeof type !== "number" || !typeIsAllocationBacked(type, typing)) {
    return false;
  }
  return (
    access.localPaths !== undefined &&
    access.localPaths.length > 0 &&
    access.localPaths.every(
      (path) =>
        path.findLastIndex((projection) => projection.kind === "dereference") <=
        0,
    )
  );
};

const guardOperandDisplay = ({
  access,
  symbolTable,
}: {
  access: OrdinaryAccess;
  symbolTable: SymbolTable;
}): string => {
  const place = access.argument.place!;
  const root = symbolTable.hasSymbol(place.root)
    ? symbolTable.getSymbol(place.root).name
    : `value ${place.root}`;
  return `argument ${access.parameter + 1} place ${root}${place.projections
    .map(displayProjection)
    .join("")}`;
};

const displayProjection = (projection: PlaceProjection): string => {
  switch (projection.kind) {
    case "field":
      return `.${projection.name}`;
    case "tuple":
      return `[${projection.index}]`;
    case "index":
      return projection.constant === undefined
        ? "[dynamic index]"
        : `[${projection.constant}]`;
    case "dereference":
    case "identity":
    case "discriminant":
      return "";
  }
};

const sameGuard = (
  left: RuntimeIdentityGuard,
  right: RuntimeIdentityGuard,
): boolean =>
  left.left.parameter === right.left.parameter &&
  left.right.parameter === right.right.parameter &&
  JSON.stringify(left.left.allocationPath) ===
    JSON.stringify(right.left.allocationPath) &&
  JSON.stringify(left.right.allocationPath) ===
    JSON.stringify(right.right.allocationPath) &&
  left.left.identity === right.left.identity &&
  left.right.identity === right.right.identity;

const displayPlace = (
  index: CallableBorrowIndex,
  place: BorrowPlace,
): string => {
  const source = index.parameterPlaces.get(place.root);
  if (!source) return "an argument place";
  const suffix = [...source.path, ...place.projections]
    .map((projection) =>
      projection.kind === "field"
        ? `.${projection.name}`
        : projection.kind === "tuple"
          ? `[${projection.index}]`
          : "",
    )
    .join("");
  return `parameter ${source.parameter + 1}${suffix}`;
};

const overlapDiagnostic = ({
  index,
  call,
  left,
  right,
}: {
  index: CallableBorrowIndex;
  call: CallableBorrowIndexCall;
  left: OrdinaryAccess;
  right: OrdinaryAccess;
}): Diagnostic => {
  const mutable = left.access === OrdinaryParameterAccess.Write ? left : right;
  const existing = mutable === left ? right : left;
  return diagnosticFromCode({
    code: "TY0048",
    params: {
      kind: "borrow-conflict",
      access: "mutably borrow",
      place: displayPlace(index, mutable.argument.place!),
      existing:
        existing.access === OrdinaryParameterAccess.Write
          ? "mutable"
          : "shared",
    },
    span: call.span,
    related: [
      diagnosticFromCode({
        code: "TY0048",
        params: {
          kind: "borrow-origin",
          place: displayPlace(index, existing.argument.place!),
          borrow:
            existing.access === OrdinaryParameterAccess.Write
              ? "mutable"
              : "shared",
        },
        span: call.span,
        severity: "note",
      }),
    ],
  });
};
