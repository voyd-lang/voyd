import { incrementCompilerPerfCounter } from "../../perf.js";
import type { SymbolId } from "../ids.js";
import type { FunctionSignature } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import {
  indexCallArgumentFor,
  parameterPlaceForIndexPlace,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";

/**
 * Finite, whole-parameter access lattice used by ordinary mutation analysis.
 * Numeric ordering makes join and upper-bound checks constant-time.
 */
export enum OrdinaryParameterAccess {
  Unused = 0,
  Read = 1,
  Write = 2,
}

export type OrdinaryMutationSummary = {
  directAccesses: readonly OrdinaryParameterAccess[];
  reachableAccesses: readonly OrdinaryParameterAccess[];
  ambientAccess: OrdinaryParameterAccess;
  reentrant: boolean;
  maySuspend: boolean;
};

export type OrdinaryMutationCallArgument = {
  parameter: number;
  callerParameter?: number;
  callerAccess?: "direct" | "reachable";
  /** Direct access touches a fresh local outer identity, not retained inputs. */
  freshOuter?: true;
  ambientObject: boolean;
  mayAliasParameters: readonly number[];
  fallbackAccess: OrdinaryParameterAccess;
};

export type OrdinaryMutationCall = {
  targets: readonly SymbolRef[];
  arguments: readonly OrdinaryMutationCallArgument[];
  /** Signature upper bound for dynamic dispatch; concrete targets are ignored. */
  dynamicBound?: OrdinaryMutationSummary;
  /** Exact std Array cursor step; retained Array origins are read-only. */
  compilerArrayIteratorNext?: true;
  unknownTarget: boolean;
  /** Local closure whose hazards replace an exact boundary's callback bit. */
  exactLocalCallbackSymbol?: SymbolId;
};

export const ordinaryMutationDynamicBoundSummary = (
  bound: NonNullable<CallableBorrowIndexCall["ordinaryDynamicBound"]>,
): OrdinaryMutationSummary => {
  const accesses = bound.parameterBindingKinds.map((kind) =>
    kind === "mutable-ref"
      ? OrdinaryParameterAccess.Write
      : OrdinaryParameterAccess.Read,
  );
  return {
    directAccesses: accesses,
    reachableAccesses: accesses,
    ambientAccess:
      bound.ambientAccess === "write"
        ? OrdinaryParameterAccess.Write
        : bound.ambientAccess === "read"
          ? OrdinaryParameterAccess.Read
          : OrdinaryParameterAccess.Unused,
    reentrant: bound.reentrant,
    maySuspend: bound.maySuspend,
  };
};

/** Bounded solver input extracted from the existing cheap callable index. */
export type OrdinaryMutationInput = {
  symbol: SymbolId;
  direct: OrdinaryMutationSummary;
  calls: readonly OrdinaryMutationCall[];
  callEdges: readonly SymbolRef[];
};

export type OrdinaryMutationBoundViolation =
  | {
      kind: "parameter-count";
      symbol?: SymbolId;
      actual: number;
      allowed: number;
    }
  | {
      kind: "parameter-access";
      symbol?: SymbolId;
      parameter: number;
      access: "direct" | "reachable";
      actual: OrdinaryParameterAccess;
      allowed: OrdinaryParameterAccess;
    }
  | {
      kind: "ambient-object-access" | "unknown-callback" | "suspension";
      symbol?: SymbolId;
      actual?: OrdinaryParameterAccess;
      allowed?: OrdinaryParameterAccess;
    };

export type OrdinaryMutationMetrics = {
  callableCount: number;
  callEdgeCount: number;
  strictSummaryAscents: number;
  dependencyEnqueues: number;
  summaryEvaluations: number;
  sccBodyVisits: number;
  solverEvaluationBound: number;
  solverBoundUsage: number;
  /** Callable reevaluations caused by a changed dependency in the same SCC. */
  sccReevaluations: number;
  retainedSummaryBytes: number;
  ordinaryProjectionFamilies: 0;
  ordinaryWidenings: 0;
};

export type OrdinaryMutationSolveResult = {
  summaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  metrics: OrdinaryMutationMetrics;
  declarationBoundViolations: readonly OrdinaryMutationBoundViolation[];
  /** False means the caller did not provide implementation-to-declaration bounds. */
  traitDeclarationBoundsValidated: boolean;
};

export const emptyOrdinaryMutationSummary = (
  parameterCount: number,
): OrdinaryMutationSummary => ({
  directAccesses: Array.from(
    { length: parameterCount },
    () => OrdinaryParameterAccess.Unused,
  ),
  reachableAccesses: Array.from(
    { length: parameterCount },
    () => OrdinaryParameterAccess.Unused,
  ),
  ambientAccess: OrdinaryParameterAccess.Unused,
  reentrant: false,
  maySuspend: false,
});

export const joinOrdinaryParameterAccess = (
  left: OrdinaryParameterAccess,
  right: OrdinaryParameterAccess,
): OrdinaryParameterAccess => Math.max(left, right) as OrdinaryParameterAccess;

export const ordinaryMutationSummariesEqual = (
  left: OrdinaryMutationSummary | undefined,
  right: OrdinaryMutationSummary | undefined,
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.ambientAccess !== right.ambientAccess ||
    left.reentrant !== right.reentrant ||
    left.maySuspend !== right.maySuspend ||
    left.directAccesses.length !== right.directAccesses.length ||
    left.reachableAccesses.length !== right.reachableAccesses.length
  ) {
    return false;
  }
  return (
    left.directAccesses.every(
      (access, parameter) => access === right.directAccesses[parameter],
    ) &&
    left.reachableAccesses.every(
      (access, parameter) => access === right.reachableAccesses[parameter],
    )
  );
};

export const joinOrdinaryMutationSummaries = (
  left: OrdinaryMutationSummary,
  right: OrdinaryMutationSummary,
): OrdinaryMutationSummary => {
  const parameterCount = Math.max(
    left.directAccesses.length,
    right.directAccesses.length,
    left.reachableAccesses.length,
    right.reachableAccesses.length,
  );
  return {
    directAccesses: Array.from({ length: parameterCount }, (_, parameter) =>
      joinOrdinaryParameterAccess(
        left.directAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
        right.directAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
      ),
    ),
    reachableAccesses: Array.from({ length: parameterCount }, (_, parameter) =>
      joinOrdinaryParameterAccess(
        left.reachableAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
        right.reachableAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
      ),
    ),
    ambientAccess: joinOrdinaryParameterAccess(
      left.ambientAccess,
      right.ambientAccess,
    ),
    reentrant: left.reentrant || right.reentrant,
    maySuspend: left.maySuspend || right.maySuspend,
  };
};

export const applyExactLocalCallbackHazards = ({
  call,
  callee,
  localSummaries,
}: {
  call: Pick<OrdinaryMutationCall, "exactLocalCallbackSymbol">;
  callee: OrdinaryMutationSummary;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
}): OrdinaryMutationSummary => {
  const callback =
    call.exactLocalCallbackSymbol === undefined
      ? undefined
      : localSummaries.get(call.exactLocalCallbackSymbol);
  return callback
    ? {
        ...callee,
        ambientAccess: joinOrdinaryParameterAccess(
          callee.ambientAccess,
          callback.ambientAccess,
        ),
        reentrant: callback.reentrant,
        maySuspend: callee.maySuspend || callback.maySuspend,
      }
    : callee;
};

/**
 * Dynamic dispatch uses the declaration's signature access ceiling, never a
 * join of field-sensitive implementation contracts.
 */
export const ordinaryMutationSignatureUpperBound = ({
  signature,
  maySuspend = false,
}: {
  signature: Pick<FunctionSignature, "parameters">;
  maySuspend?: boolean;
}): OrdinaryMutationSummary => ({
  directAccesses: signature.parameters.map((parameter) =>
    parameter.bindingKind === "mutable-ref"
      ? OrdinaryParameterAccess.Write
      : OrdinaryParameterAccess.Read,
  ),
  reachableAccesses: signature.parameters.map((parameter) =>
    parameter.bindingKind === "mutable-ref"
      ? OrdinaryParameterAccess.Write
      : OrdinaryParameterAccess.Read,
  ),
  ambientAccess: OrdinaryParameterAccess.Unused,
  reentrant: false,
  maySuspend,
});

export const validateOrdinaryMutationSummaryBound = ({
  implementation,
  declaration,
  symbol,
}: {
  implementation: OrdinaryMutationSummary;
  declaration: OrdinaryMutationSummary;
  symbol?: SymbolId;
}): readonly OrdinaryMutationBoundViolation[] => {
  const violations: OrdinaryMutationBoundViolation[] = [];
  if (
    implementation.directAccesses.length !==
      declaration.directAccesses.length ||
    implementation.reachableAccesses.length !==
      declaration.reachableAccesses.length
  ) {
    violations.push({
      kind: "parameter-count",
      ...(symbol === undefined ? {} : { symbol }),
      actual: Math.max(
        implementation.directAccesses.length,
        implementation.reachableAccesses.length,
      ),
      allowed: Math.max(
        declaration.directAccesses.length,
        declaration.reachableAccesses.length,
      ),
    });
  }
  const validateParameterModes = (
    access: "direct" | "reachable",
    actualModes: readonly OrdinaryParameterAccess[],
    allowedModes: readonly OrdinaryParameterAccess[],
  ): void =>
    actualModes.forEach((actual, parameter) => {
      const allowed = allowedModes[parameter];
      if (allowed === undefined || actual <= allowed) return;
      violations.push({
        kind: "parameter-access",
        ...(symbol === undefined ? {} : { symbol }),
        parameter,
        access,
        actual,
        allowed,
      });
    });
  validateParameterModes(
    "direct",
    implementation.directAccesses,
    declaration.directAccesses,
  );
  validateParameterModes(
    "reachable",
    implementation.reachableAccesses,
    declaration.reachableAccesses,
  );
  if (implementation.ambientAccess > declaration.ambientAccess) {
    violations.push({
      kind: "ambient-object-access",
      ...(symbol === undefined ? {} : { symbol }),
      actual: implementation.ambientAccess,
      allowed: declaration.ambientAccess,
    });
  }
  if (implementation.reentrant && !declaration.reentrant) {
    violations.push({
      kind: "unknown-callback",
      ...(symbol === undefined ? {} : { symbol }),
    });
  }
  if (implementation.maySuspend && !declaration.maySuspend) {
    violations.push({
      kind: "suspension",
      ...(symbol === undefined ? {} : { symbol }),
    });
  }
  return violations;
};

const withParameterAccess = (
  summary: OrdinaryMutationSummary,
  parameter: number,
  kind: "direct" | "reachable",
  access: OrdinaryParameterAccess,
): OrdinaryMutationSummary => {
  const accesses =
    kind === "direct" ? summary.directAccesses : summary.reachableAccesses;
  const current = accesses[parameter];
  if (current === undefined || current >= access) return summary;
  const next = [...accesses];
  next[parameter] = access;
  return kind === "direct"
    ? { ...summary, directAccesses: next }
    : { ...summary, reachableAccesses: next };
};

const withParameterPathAccess = (
  summary: OrdinaryMutationSummary,
  parameter: number,
  path: readonly { kind: string }[],
  parameterAllocationBacked: boolean,
  access: OrdinaryParameterAccess,
): OrdinaryMutationSummary => {
  const boundaryPath =
    parameterAllocationBacked && path[0]?.kind === "dereference"
      ? path.slice(1)
      : path;
  const reachable = boundaryPath.some(
    (projection) => projection.kind === "dereference",
  );
  if (!reachable) {
    return withParameterAccess(summary, parameter, "direct", access);
  }
  const withHandleRead = withParameterAccess(
    summary,
    parameter,
    "direct",
    OrdinaryParameterAccess.Read,
  );
  return withParameterAccess(withHandleRead, parameter, "reachable", access);
};

const withAmbientAccess = (
  summary: OrdinaryMutationSummary,
  access: OrdinaryParameterAccess,
): OrdinaryMutationSummary =>
  summary.ambientAccess >= access
    ? summary
    : { ...summary, ambientAccess: access };

const directAccesses = (
  index: CallableBorrowIndex,
): OrdinaryMutationSummary => {
  let summary: OrdinaryMutationSummary = {
    ...emptyOrdinaryMutationSummary(index.parameters.length),
    maySuspend: index.flags.hasSuspension,
  };
  index.accesses.forEach((access) => {
    if (
      access.role === "projection-base" ||
      (access.role === "call-argument" && access.referenceArgument === true) ||
      access.role === "call-operand" ||
      (access.role === "assignment-target" && access.kind === "read")
    ) {
      return;
    }
    if (
      access.place &&
      ((index.directAmbientObjectRoots ?? []).includes(access.place.root) ||
        (index.ambientObjectCaptures ?? []).includes(access.place.root))
    ) {
      summary = withAmbientAccess(
        summary,
        access.kind === "write"
          ? OrdinaryParameterAccess.Write
          : OrdinaryParameterAccess.Read,
      );
    }
    const source = parameterPlaceForIndexPlace(index, access.place);
    if (!source) return;
    summary = withParameterPathAccess(
      summary,
      source.parameter,
      source.path,
      index.parameters[source.parameter]?.allocationBacked === true,
      access.kind === "write"
        ? OrdinaryParameterAccess.Write
        : OrdinaryParameterAccess.Read,
    );
  });
  index.calls.forEach((call) => {
    const access = intrinsicParameterAccess(call);
    if (access === OrdinaryParameterAccess.Unused) return;
    const argument = indexCallArgumentFor(call, 0);
    const source = parameterPlaceForIndexPlace(index, argument?.place);
    if (source) {
      summary = withParameterPathAccess(
        summary,
        source.parameter,
        source.path,
        index.parameters[source.parameter]?.allocationBacked === true,
        intrinsicAccessAtCallableBoundary({ access, index, source }),
      );
      return;
    }
    if (argument?.moduleStorage === true) {
      summary = withAmbientAccess(summary, access);
    }
  });
  return summary;
};

const intrinsicAccessAtCallableBoundary = ({
  access,
  index,
  source,
}: {
  access: OrdinaryParameterAccess;
  index: CallableBorrowIndex;
  source: { parameter: number };
}): OrdinaryParameterAccess => {
  if (
    access !== OrdinaryParameterAccess.Write ||
    index.parameters[source.parameter]?.access === "mutable"
  ) {
    return access;
  }
  // __array_set physically updates FixedArray storage, including the owned
  // storage used to build a returned value. Across a callable boundary that
  // implementation detail is a read of a plain/shared input; only storage
  // reached through a mutable parameter publishes a logical write.
  return OrdinaryParameterAccess.Read;
};

const intrinsicParameterAccess = (
  call: CallableBorrowIndexCall,
): OrdinaryParameterAccess => {
  switch (call.intrinsicName) {
    case "__array_set":
      return OrdinaryParameterAccess.Write;
    case "__array_get":
    case "__array_len":
    case "__ref_is_null":
      return OrdinaryParameterAccess.Read;
    default:
      return OrdinaryParameterAccess.Unused;
  }
};

const fallbackAccessForArgument = (
  call: CallableBorrowIndexCall,
  parameter: number,
): OrdinaryParameterAccess => {
  const bindingKind =
    call.signature?.parameters[parameter]?.bindingKind ??
    indexCallArgumentFor(call, parameter)?.bindingKind;
  if (bindingKind === "mutable-ref") return OrdinaryParameterAccess.Write;
  if (bindingKind === "immutable-ref") return OrdinaryParameterAccess.Read;
  const argument = indexCallArgumentFor(call, parameter);
  return argument?.loanBearing === true || argument?.referenceCapable === true
    ? OrdinaryParameterAccess.Read
    : OrdinaryParameterAccess.Unused;
};

const callInput = ({
  call,
  index,
}: {
  call: CallableBorrowIndexCall;
  index: CallableBorrowIndex;
}): OrdinaryMutationCall | undefined => {
  if (
    call.intrinsic ||
    call.scopedSharedCellAccess === true ||
    call.ordinaryMutationFreeConstruction === true
  ) {
    return undefined;
  }
  const dynamicBound = call.ordinaryDynamicBound
    ? ordinaryMutationDynamicBoundSummary(call.ordinaryDynamicBound)
    : call.openTraitDispatch === true && call.signature
      ? {
          ...ordinaryMutationSignatureUpperBound({
            signature: call.signature,
          }),
          ambientAccess: OrdinaryParameterAccess.Write,
          reentrant: true,
          maySuspend: true,
        }
      : undefined;
  return {
    targets: [...call.targets],
    arguments: call.arguments.map((argument) => {
      const source = parameterPlaceForIndexPlace(index, argument.place);
      return {
        parameter: argument.parameter,
        ...(argument.fresh === true ? { freshOuter: true as const } : {}),
        ...(source ? { callerParameter: source.parameter } : {}),
        ...(source
          ? {
              callerAccess:
                source.path.some(
                  (projection) => projection.kind !== "identity",
                ) &&
                argument.referenceCapable === true &&
                argument.bindingKind !== "mutable-ref" &&
                argument.bindingKind !== "immutable-ref"
                  ? ("reachable" as const)
                  : ("direct" as const),
            }
          : {}),
        ambientObject: argument.moduleStorage === true,
        mayAliasParameters:
          source === undefined &&
          argument.moduleStorage !== true &&
          (argument.referenceCapable === true ||
            argument.loanBearing === true ||
            argument.defaulted === true)
            ? (argument.callerParameterOrigins ??
              index.parameters.flatMap((parameter) =>
                parameter.referenceCapable === true
                  ? [parameter.parameter]
                  : [],
              ))
            : [],
        fallbackAccess: fallbackAccessForArgument(call, argument.parameter),
      };
    }),
    ...(dynamicBound ? { dynamicBound } : {}),
    ...(call.compilerArrayIteratorNext === true
      ? { compilerArrayIteratorNext: true as const }
      : {}),
    ...(call.exactLocalCallbackSymbol === undefined
      ? {}
      : { exactLocalCallbackSymbol: call.exactLocalCallbackSymbol }),
    unknownTarget:
      dynamicBound === undefined &&
      (call.targets.length === 0 || call.argumentPlanAmbiguous === true),
  };
};

/**
 * Collapse local projections in `CallableBorrowIndex` to bounded, whole-
 * parameter solver input. No provenance, paths, or result facts survive.
 */
export const extractOrdinaryMutationInput = (
  index: CallableBorrowIndex,
): OrdinaryMutationInput => ({
  symbol: index.symbol,
  direct: directAccesses(index),
  calls: index.calls.flatMap((call) => {
    const input = callInput({ call, index });
    return input ? [input] : [];
  }),
  callEdges: [...index.directCallEdges],
});

const targetKey = ({ moduleId, symbol }: SymbolRef): string =>
  `${moduleId}::${symbol}`;

const applyAccessToArgument = ({
  access,
  kind,
  argument,
  summary,
}: {
  access: OrdinaryParameterAccess;
  kind: "direct" | "reachable";
  argument: OrdinaryMutationCallArgument | undefined;
  summary: OrdinaryMutationSummary;
}): OrdinaryMutationSummary => {
  if (access === OrdinaryParameterAccess.Unused || !argument) return summary;
  if (argument.callerParameter !== undefined) {
    const callerKind =
      kind === "reachable" || argument.callerAccess === "reachable"
        ? "reachable"
        : "direct";
    const withAccess = withParameterAccess(
      summary,
      argument.callerParameter,
      callerKind,
      access,
    );
    return callerKind === "reachable"
      ? withParameterAccess(
          withAccess,
          argument.callerParameter,
          "direct",
          OrdinaryParameterAccess.Read,
        )
      : withAccess;
  }
  if (argument.ambientObject) {
    return withAmbientAccess(summary, access);
  }
  if (argument.freshOuter === true && kind === "direct") return summary;
  return argument.mayAliasParameters.reduce((current, parameter) => {
    const withAccess = withParameterAccess(
      current,
      parameter,
      "reachable",
      access,
    );
    return withParameterAccess(
      withAccess,
      parameter,
      "direct",
      OrdinaryParameterAccess.Read,
    );
  }, summary);
};

const applyCalleeSummary = ({
  callee,
  call,
  summary,
}: {
  callee: OrdinaryMutationSummary;
  call: OrdinaryMutationCall;
  summary: OrdinaryMutationSummary;
}): OrdinaryMutationSummary => {
  let next = {
    ...summary,
    ambientAccess: joinOrdinaryParameterAccess(
      summary.ambientAccess,
      callee.ambientAccess,
    ),
    reentrant: summary.reentrant || callee.reentrant,
    maySuspend: summary.maySuspend || callee.maySuspend,
  };
  callee.directAccesses.forEach((access, parameter) => {
    const effectiveAccess =
      call.compilerArrayIteratorNext === true && parameter === 0
        ? OrdinaryParameterAccess.Read
        : access;
    next = applyAccessToArgument({
      access: effectiveAccess,
      kind: "direct",
      argument: call.arguments.find(
        (argument) => argument.parameter === parameter,
      ),
      summary: next,
    });
  });
  callee.reachableAccesses.forEach((access, parameter) => {
    const effectiveAccess =
      call.compilerArrayIteratorNext === true && parameter === 0
        ? OrdinaryParameterAccess.Read
        : access;
    next = applyAccessToArgument({
      access: effectiveAccess,
      kind: "reachable",
      argument: call.arguments.find(
        (argument) => argument.parameter === parameter,
      ),
      summary: next,
    });
  });
  return next;
};

const applyUnknownTarget = ({
  call,
  summary,
}: {
  call: OrdinaryMutationCall;
  summary: OrdinaryMutationSummary;
}): OrdinaryMutationSummary => {
  let next: OrdinaryMutationSummary = {
    ...summary,
    reentrant: true,
  };
  call.arguments.forEach((argument) => {
    next = applyAccessToArgument({
      access: argument.fallbackAccess,
      kind: "direct",
      argument,
      summary: next,
    });
    next = applyAccessToArgument({
      access: argument.fallbackAccess,
      kind: "reachable",
      argument,
      summary: next,
    });
  });
  return next;
};

const evaluateInput = ({
  input,
  summaries,
  moduleId,
  importedSummaries,
}: {
  input: OrdinaryMutationInput;
  summaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  moduleId: string;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
}): OrdinaryMutationSummary =>
  input.calls.reduce((summary, call) => {
    if (call.dynamicBound) {
      return applyCalleeSummary({
        callee: call.dynamicBound,
        call,
        summary,
      });
    }
    let next = summary;
    let unknownTarget = call.unknownTarget;
    call.targets.forEach((target) => {
      const callee =
        target.moduleId === moduleId
          ? summaries.get(target.symbol)
          : importedSummaries.get(targetKey(target));
      if (!callee) {
        unknownTarget = true;
        return;
      }
      const boundedCallee = applyExactLocalCallbackHazards({
        call,
        callee,
        localSummaries: summaries,
      });
      next = applyCalleeSummary({ callee: boundedCallee, call, summary: next });
    });
    return unknownTarget ? applyUnknownTarget({ call, summary: next }) : next;
  }, input.direct);

const localDependencies = ({
  input,
  inputs,
  moduleId,
}: {
  input: OrdinaryMutationInput;
  inputs: ReadonlyMap<SymbolId, OrdinaryMutationInput>;
  moduleId: string;
}): ReadonlySet<SymbolId> =>
  new Set(
    input.calls.flatMap((call) =>
      call.dynamicBound
        ? []
        : [
            ...call.targets.flatMap((target) =>
              target.moduleId === moduleId && inputs.has(target.symbol)
                ? [target.symbol]
                : [],
            ),
            ...(call.exactLocalCallbackSymbol !== undefined &&
            inputs.has(call.exactLocalCallbackSymbol)
              ? [call.exactLocalCallbackSymbol]
              : []),
          ],
    ),
  );

const stronglyConnectedComponents = ({
  symbols,
  dependencies,
}: {
  symbols: readonly SymbolId[];
  dependencies: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
}): readonly (readonly SymbolId[])[] => {
  const sourceOrder = new Map(symbols.map((symbol, index) => [symbol, index]));
  const discoveryIndexes = new Map<SymbolId, number>();
  const lowLinks = new Map<SymbolId, number>();
  const stack: SymbolId[] = [];
  const onStack = new Set<SymbolId>();
  const components: SymbolId[][] = [];
  let nextIndex = 0;
  const visit = (symbol: SymbolId): void => {
    discoveryIndexes.set(symbol, nextIndex);
    lowLinks.set(symbol, nextIndex);
    nextIndex += 1;
    stack.push(symbol);
    onStack.add(symbol);
    (dependencies.get(symbol) ?? []).forEach((dependency) => {
      if (!discoveryIndexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          symbol,
          Math.min(lowLinks.get(symbol)!, lowLinks.get(dependency)!),
        );
        return;
      }
      if (onStack.has(dependency)) {
        lowLinks.set(
          symbol,
          Math.min(lowLinks.get(symbol)!, discoveryIndexes.get(dependency)!),
        );
      }
    });
    if (lowLinks.get(symbol) !== discoveryIndexes.get(symbol)) return;
    const component: SymbolId[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === symbol) break;
    }
    component.sort(
      (left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!,
    );
    components.push(component);
  };
  symbols.forEach((symbol) => {
    if (!discoveryIndexes.has(symbol)) visit(symbol);
  });
  return components;
};

/** Maximum number of unit ascents in the refined finite summary lattice. */
export const ordinaryMutationSummaryHeight = (parameterCount: number): number =>
  4 * parameterCount + 4;

/** Fixed-size retained representation: parameter count, flag byte, and modes. */
export const ordinaryMutationSummaryRetainedBytes = (
  summary: OrdinaryMutationSummary,
): number =>
  6 + summary.directAccesses.length + summary.reachableAccesses.length;

export const recordOrdinaryMutationMetrics = (
  metrics: OrdinaryMutationMetrics,
): void => {
  incrementCompilerPerfCounter(
    "borrowing.ordinary.callables",
    metrics.callableCount,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.callEdges",
    metrics.callEdgeCount,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.strictAscents",
    metrics.strictSummaryAscents,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.dependencyEnqueues",
    metrics.dependencyEnqueues,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.summaryEvaluations",
    metrics.summaryEvaluations,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.sccReevaluations",
    metrics.sccReevaluations,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.sccBodyVisits",
    metrics.sccBodyVisits,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.solverBound",
    metrics.solverEvaluationBound,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.solverBoundUsage",
    metrics.solverBoundUsage,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.retainedSummaryBytes",
    metrics.retainedSummaryBytes,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.projectionFamilies",
    metrics.ordinaryProjectionFamilies,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinary.widenings",
    metrics.ordinaryWidenings,
  );
};

/**
 * Solve finite summaries callee-first. An SCC has an internal caller worklist;
 * a changed summary queues only its callers, and downstream SCCs run only
 * after all of their callee SCCs have converged.
 */
export const solveOrdinaryMutationSummaries = ({
  inputs,
  moduleId,
  importedSummaries = new Map(),
  declarationBounds,
  recordMetrics = true,
}: {
  inputs: ReadonlyMap<SymbolId, OrdinaryMutationInput>;
  moduleId: string;
  importedSummaries?: ReadonlyMap<string, OrdinaryMutationSummary>;
  declarationBounds?: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  recordMetrics?: boolean;
}): OrdinaryMutationSolveResult => {
  const symbols = [...inputs.keys()];
  const sourceOrder = new Map(symbols.map((symbol, index) => [symbol, index]));
  const dependencies = new Map(
    symbols.map((symbol) => [
      symbol,
      localDependencies({ input: inputs.get(symbol)!, inputs, moduleId }),
    ]),
  );
  const callers = new Map(
    symbols.map((symbol) => [symbol, new Set<SymbolId>()]),
  );
  dependencies.forEach((callees, caller) =>
    callees.forEach((callee) => callers.get(callee)!.add(caller)),
  );
  const components = stronglyConnectedComponents({ symbols, dependencies });
  const componentBySymbol = new Map<SymbolId, number>();
  components.forEach((component, componentIndex) =>
    component.forEach((symbol) =>
      componentBySymbol.set(symbol, componentIndex),
    ),
  );
  const componentDependencies = components.map(() => new Set<number>());
  const callerComponents = components.map(() => new Set<number>());
  dependencies.forEach((callees, caller) => {
    const callerComponent = componentBySymbol.get(caller)!;
    callees.forEach((callee) => {
      const calleeComponent = componentBySymbol.get(callee)!;
      if (callerComponent === calleeComponent) return;
      componentDependencies[callerComponent]!.add(calleeComponent);
      callerComponents[calleeComponent]!.add(callerComponent);
    });
  });
  const remainingDependencies = componentDependencies.map(
    (entries) => entries.size,
  );
  const componentOrder = (component: number): number =>
    Math.min(
      ...components[component]!.map((symbol) => sourceOrder.get(symbol)!),
    );
  const componentWorklist = components
    .map((_component, index) => index)
    .filter((index) => remainingDependencies[index] === 0)
    .sort((left, right) => componentOrder(left) - componentOrder(right));
  const summaries = new Map(
    Array.from(inputs, ([symbol, input]) => [symbol, input.direct]),
  );
  const solverEvaluationBound =
    inputs.size +
    Array.from(dependencies.values()).reduce(
      (bound, callees) =>
        bound +
        Array.from(callees).reduce(
          (calleeBound, callee) =>
            calleeBound +
            ordinaryMutationSummaryHeight(
              inputs.get(callee)?.direct.directAccesses.length ?? 0,
            ),
          0,
        ),
      0,
    );
  let strictSummaryAscents = 0;
  let dependencyEnqueues = 0;
  let summaryEvaluations = 0;
  let sccBodyVisits = 0;
  let sccReevaluations = 0;
  while (componentWorklist.length > 0) {
    const componentIndex = componentWorklist.shift()!;
    const component = components[componentIndex]!;
    const members = new Set(component);
    const worklist = [...component];
    const queued = new Set(worklist);
    const evaluated = new Set<SymbolId>();
    while (worklist.length > 0) {
      const symbol = worklist.shift()!;
      queued.delete(symbol);
      if (evaluated.has(symbol)) sccReevaluations += 1;
      evaluated.add(symbol);
      summaryEvaluations += 1;
      sccBodyVisits += 1;
      const candidate = evaluateInput({
        input: inputs.get(symbol)!,
        summaries,
        moduleId,
        importedSummaries,
      });
      if (ordinaryMutationSummariesEqual(summaries.get(symbol), candidate)) {
        continue;
      }
      strictSummaryAscents += 1;
      summaries.set(symbol, candidate);
      (callers.get(symbol) ?? []).forEach((caller) => {
        if (!members.has(caller) || queued.has(caller)) return;
        dependencyEnqueues += 1;
        queued.add(caller);
        worklist.push(caller);
      });
    }
    callerComponents[componentIndex]!.forEach((callerComponent) => {
      remainingDependencies[callerComponent] =
        remainingDependencies[callerComponent]! - 1;
      if (remainingDependencies[callerComponent] !== 0) return;
      componentWorklist.push(callerComponent);
      componentWorklist.sort(
        (left, right) => componentOrder(left) - componentOrder(right),
      );
    });
  }
  const uniqueEdges = new Set<string>();
  inputs.forEach((input) =>
    input.callEdges.forEach((target) =>
      uniqueEdges.add(`${input.symbol}->${targetKey(target)}`),
    ),
  );
  const metrics: OrdinaryMutationMetrics = {
    callableCount: inputs.size,
    callEdgeCount: uniqueEdges.size,
    strictSummaryAscents,
    dependencyEnqueues,
    summaryEvaluations,
    sccBodyVisits,
    solverEvaluationBound,
    solverBoundUsage: summaryEvaluations,
    sccReevaluations,
    retainedSummaryBytes: Array.from(summaries.values()).reduce(
      (bytes, summary) => bytes + ordinaryMutationSummaryRetainedBytes(summary),
      0,
    ),
    ordinaryProjectionFamilies: 0,
    ordinaryWidenings: 0,
  };
  if (summaryEvaluations > solverEvaluationBound) {
    throw new Error(
      `ordinary mutation solver exceeded finite bound: ${summaryEvaluations} > ${solverEvaluationBound}`,
    );
  }
  if (recordMetrics) recordOrdinaryMutationMetrics(metrics);
  const declarationBoundViolations = declarationBounds
    ? Array.from(declarationBounds).flatMap(([symbol, declaration]) => {
        const implementation = summaries.get(symbol);
        return implementation
          ? validateOrdinaryMutationSummaryBound({
              implementation,
              declaration,
              symbol,
            })
          : [];
      })
    : [];
  return {
    summaries,
    metrics,
    declarationBoundViolations,
    traitDeclarationBoundsValidated: declarationBounds !== undefined,
  };
};
