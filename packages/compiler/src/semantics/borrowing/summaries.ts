import type { SymbolTable } from "../binder/index.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import {
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import type {
  BorrowTypeComparison,
  CallableBorrowContract,
  CallableBorrowTransfer,
  CallableParameterBorrowContract,
  DefaultBorrowAccessOrigin,
  DefaultBorrowOrigin,
  PlaceProjection,
  ReturnedBorrowOrigin,
  ReturnedTypeMatchingOrigin,
  ScopedCallbackBorrowContract,
} from "./model.js";
import {
  borrowTypeConditionId,
  callableContractHasGuardableAccessPair,
  mergeCallableBorrowContracts,
  normalizeCallableBorrowTransfers,
  projectionPathCovers,
  projectionsOverlap,
  translateProjectionPath,
} from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import {
  materializedObjectReferencePaths,
  projectedTypes,
  resolveBorrowCallFromFact,
  type ResolvedBorrowCall,
} from "./call-resolution.js";
import {
  referenceOriginsInType,
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";
import {
  borrowedPathsInType,
  borrowedTypeEntriesInType,
  typeContainsBorrowed,
  typeParameterPathsInType,
} from "./borrowed-types.js";
import { traitRegionProjectionsForCoercion } from "./trait-region-projection.js";
import {
  factValueRequests,
  type CallableBorrowFacts,
} from "./callable-facts.js";

type ParameterOrigin = {
  parameter: number;
  sourceEndpointAccess: "inline" | "dereferenced";
  sourceProjections: readonly PlaceProjection[];
  resultProjections: readonly PlaceProjection[];
  resultNominal?: TypeId;
  borrowed?: true;
  shared?: true;
  retainedUnlessBorrowed?: true;
  fresh?: true;
  defaultParameter?: number;
  returnTypeConditionId?: string;
  accessTypeComparator?: {
    conditionId: string;
    parameter: number;
    sourceProjections: readonly PlaceProjection[];
  };
};
const EXTERNAL_STORAGE_PARAMETER = -1;
type Flow = ReadonlyMap<string, ParameterOrigin>;
type MutableFlow = Map<string, ParameterOrigin>;
type MutableEnv = Map<SymbolId, MutableFlow>;
type ReturnSnapshot = {
  flow: Flow;
  invalidated: Flow;
};

const MAX_FLOW_PROJECTION_DEPTH = 8;
const MAX_FLOW_PATHS_PER_PARAMETER = 32;

const originKeys = new WeakMap<ParameterOrigin, string>();
const contractEqualityKeys = new WeakMap<CallableBorrowContract, string>();
type FlowWideningState = {
  parameterCounts: Map<number, number>;
  broadFamilies: Set<string>;
};
const flowWideningStates = new WeakMap<MutableFlow, FlowWideningState>();

type SummaryContext = {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  borrowIndexMode: "symbolic";
  accessed: MutableFlow;
  written: MutableFlow;
  uncheckedWritten: MutableFlow;
  retained: MutableFlow;
  externalRetained: MutableFlow;
  borrowedRetained: MutableFlow;
  returned: MutableFlow;
  maySuspend: { value: boolean };
  scopedCallbacks: Map<string, ScopedCallbackBorrowContract>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  callResolutionCache: Map<HirExprId, ResolvedBorrowCall>;
  parameterOrigins: Map<SymbolId, number>;
  parameterSymbolFlows: ReadonlyMap<SymbolId, Flow>;
  placeEnvs: Map<MutableEnv, Map<SymbolId, MutableFlow>>;
  expressionFlows: Map<MutableEnv, Map<HirExprId, MutableFlow>>;
  localOwnedRoots: Set<SymbolId>;
  invalidated: Map<MutableEnv, MutableFlow>;
  returnSnapshots: ReturnSnapshot[];
  freshReturns: boolean[];
  borrowedReturnType?: TypeId;
  borrowedReturnPaths: readonly (readonly PlaceProjection[])[];
  transfers: Map<string, CallableBorrowTransfer>;
  decls: DeclTable;
  facts: CallableBorrowFacts;
  lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts>;
};

const summaryExpressionTypeFor = (
  exprId: HirExprId,
  ctx: SummaryContext,
): TypeId | undefined => ctx.facts.expressionTypes.get(exprId);

const summaryExpression = (
  exprId: HirExprId,
  ctx: SummaryContext,
): HirExpression | undefined => ctx.facts.expressions.get(exprId);

const resolvedBorrowCallFromFacts = (
  expression: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  ctx: SummaryContext,
): ResolvedBorrowCall => {
  const fact = ctx.facts.callForExpression.get(expression.id);
  if (!fact) {
    throw new Error(`missing borrow call fact for expression ${expression.id}`);
  }
  return resolveBorrowCallFromFact({ expr: expression, fact, ctx });
};

const expressionCanCarryReference = (
  exprId: HirExprId,
  ctx: SummaryContext,
): boolean => {
  const type = summaryExpressionTypeFor(exprId, ctx);
  if (typeof type !== "number") {
    return true;
  }
  return typeCanCarryReference(type, ctx.typing);
};

const isTransparentMutableAccess = (
  expression: HirExpression | undefined,
  ctx: SummaryContext,
): boolean => {
  if (expression?.exprKind !== "call") {
    return false;
  }
  const callee = summaryExpression(expression.callee, ctx);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
  };
  return (
    metadata.intrinsic === true &&
    (metadata.intrinsicName ?? record.name) === "~"
  );
};

const accessProjectionsFor = (
  exprId: HirExprId,
  projection: PlaceProjection,
  ctx: SummaryContext,
  needsDereference = false,
): readonly PlaceProjection[] => {
  const type = summaryExpressionTypeFor(exprId, ctx);
  const expression = summaryExpression(exprId, ctx);
  const transparentMutableAccess = isTransparentMutableAccess(expression, ctx);
  return typeof type === "number" &&
    typeIsAllocationBacked(type, ctx.typing) &&
    !transparentMutableAccess &&
    (expression?.exprKind !== "identifier" || needsDereference)
    ? [{ kind: "dereference" }, projection]
    : [projection];
};

const projectionPathKey = (projections: readonly PlaceProjection[]): string =>
  projections
    .map((projection) => {
      switch (projection.kind) {
        case "field":
          return `f${projection.name.length}:${projection.name}`;
        case "tuple":
          return `t${projection.index}`;
        case "index":
          return `i${projection.stable ? 1 : 0}:${projection.constant ?? ""}`;
        case "region":
          return `g${projection.scope.length}:${projection.scope}:${projection.name.length}:${projection.name}:${[...projection.disjoint].sort().join(",")}`;
        case "discriminant":
          return "d";
        case "dereference":
          return "r";
        case "identity":
          return "y";
      }
    })
    .join("/");

const originKey = (origin: ParameterOrigin): string => {
  const cached = originKeys.get(origin);
  if (cached) {
    return cached;
  }
  const comparator = origin.accessTypeComparator;
  const key = [
    origin.parameter,
    origin.sourceEndpointAccess,
    projectionPathKey(origin.sourceProjections),
    projectionPathKey(origin.resultProjections),
    origin.resultNominal ?? "",
    origin.borrowed === true ? 1 : 0,
    origin.shared === true ? 1 : 0,
    origin.retainedUnlessBorrowed === true ? 1 : 0,
    origin.fresh === true ? 1 : 0,
    origin.defaultParameter ?? "",
    origin.returnTypeConditionId ?? "",
    comparator
      ? `${comparator.conditionId.length}:${comparator.conditionId}:${comparator.parameter}:${projectionPathKey(comparator.sourceProjections)}`
      : "",
  ].join("|");
  originKeys.set(origin, key);
  return key;
};

const emptyFlow = (): MutableFlow => new Map();

const broadFlowOrigin = (origin: ParameterOrigin): ParameterOrigin => ({
  ...origin,
  sourceProjections: [],
  resultProjections: [],
  ...(origin.accessTypeComparator
    ? {
        accessTypeComparator: {
          ...origin.accessTypeComparator,
          sourceProjections: [],
        },
      }
    : {}),
});

const flowOriginFamilyKey = (origin: ParameterOrigin): string => {
  const comparator = origin.accessTypeComparator;
  return [
    origin.parameter,
    origin.sourceEndpointAccess,
    origin.resultNominal ?? "",
    origin.borrowed === true ? 1 : 0,
    origin.shared === true ? 1 : 0,
    origin.retainedUnlessBorrowed === true ? 1 : 0,
    origin.fresh === true ? 1 : 0,
    origin.defaultParameter ?? "",
    origin.returnTypeConditionId ?? "",
    comparator
      ? `${comparator.conditionId.length}:${comparator.conditionId}:${comparator.parameter}`
      : "",
  ].join("|");
};

const flowOriginIsBroad = (origin: ParameterOrigin): boolean =>
  origin.sourceProjections.length === 0 &&
  origin.resultProjections.length === 0 &&
  (origin.accessTypeComparator?.sourceProjections.length ?? 0) === 0;

const flowWideningState = (flow: MutableFlow): FlowWideningState => {
  const existing = flowWideningStates.get(flow);
  if (existing) {
    return existing;
  }
  const state: FlowWideningState = {
    parameterCounts: new Map(),
    broadFamilies: new Set(),
  };
  flow.forEach((origin) => {
    state.parameterCounts.set(
      origin.parameter,
      (state.parameterCounts.get(origin.parameter) ?? 0) + 1,
    );
    if (flowOriginIsBroad(origin)) {
      state.broadFamilies.add(flowOriginFamilyKey(origin));
    }
  });
  flowWideningStates.set(flow, state);
  return state;
};

const addBroadOrigin = (flow: MutableFlow, origin: ParameterOrigin): void => {
  const state = flowWideningState(flow);
  const broad = broadFlowOrigin(origin);
  const broadKey = originKey(broad);
  const familyKey = flowOriginFamilyKey(broad);
  if (state.broadFamilies.has(familyKey)) {
    return;
  }
  let removed = 0;
  Array.from(flow).forEach(([key, existing]) => {
    if (
      existing.parameter === origin.parameter &&
      flowOriginFamilyKey(existing) === familyKey
    ) {
      flow.delete(key);
      removed += 1;
    }
  });
  flow.set(broadKey, broad);
  state.parameterCounts.set(
    origin.parameter,
    (state.parameterCounts.get(origin.parameter) ?? 0) - removed + 1,
  );
  state.broadFamilies.add(familyKey);
  incrementCompilerPerfCounter("borrowing.summary.flowWidenings");
};

const flowWithExplicitBorrowedOrigins = ({
  flow,
  parameter,
  type,
  typing,
}: {
  flow: Flow;
  parameter: number;
  type: TypeId | undefined;
  typing: TypingResult;
}): MutableFlow => {
  if (typeof type !== "number" || !typeContainsBorrowed(type, typing)) {
    return new Map(flow);
  }
  const borrowedEntries = borrowedTypeEntriesInType(type, typing);
  if (borrowedEntries.length === 0) {
    return new Map(flow);
  }
  const base = borrowedEntries.some(({ path }) => path.length === 0)
    ? emptyFlow()
    : new Map(flow);
  borrowedEntries.forEach(({ path, inner }) => {
    const origin: ParameterOrigin = {
      parameter,
      sourceEndpointAccess: typeIsAllocationBacked(inner, typing)
        ? "dereferenced"
        : "inline",
      sourceProjections: path,
      resultProjections: path,
      borrowed: true,
      shared: true,
    };
    addOrigin(base, origin);
  });
  return base;
};

const flowMarkedForBorrowedReturn = (
  flow: Flow,
  borrowedReturnType: TypeId | undefined,
  typing: TypingResult,
): MutableFlow =>
  new Map(
    Array.from(flow.values(), (origin) => {
      const entry =
        typeof borrowedReturnType === "number"
          ? borrowedTypeEntriesInType(borrowedReturnType, typing)
              .filter(({ path }) =>
                projectionPathCovers(path, origin.resultProjections),
              )
              .sort((left, right) => right.path.length - left.path.length)[0]
          : undefined;
      const marked = entry
        ? {
            ...origin,
            borrowed: true as const,
            shared: true as const,
            sourceEndpointAccess: typeIsAllocationBacked(entry.inner, typing)
              ? ("dereferenced" as const)
              : origin.sourceEndpointAccess,
          }
        : origin;
      return [originKey(marked), marked] as const;
    }),
  );

type BorrowedResultPresence = "none" | "parameter" | "external";

const borrowedResultPresenceFromFlow = ({
  flow,
  type,
  typing,
  path = [],
}: {
  flow: Flow;
  type: TypeId | undefined;
  typing: TypingResult;
  path?: readonly PlaceProjection[];
}): BorrowedResultPresence => {
  if (typeof type !== "number") {
    const origins = Array.from(flow.values()).filter(
      (origin) => origin.borrowed === true || origin.fresh !== true,
    );
    if (
      origins.some((origin) => origin.parameter === EXTERNAL_STORAGE_PARAMETER)
    ) {
      return "external";
    }
    return origins.length > 0 ? "parameter" : "none";
  }
  const projected = projectedTypes(type, path, typing);
  const canContainBorrow = projected.some(
    (candidate) =>
      typeContainsBorrowed(candidate, typing) ||
      typeParameterPathsInType(candidate, typing).length > 0,
  );
  if (!canContainBorrow) {
    return "none";
  }
  const projectedFlow = path.length > 0 ? projectFlow(flow, path) : flow;
  const relevant = Array.from(projectedFlow.values()).filter(
    (origin) => origin.borrowed === true || origin.fresh !== true,
  );
  if (
    relevant.length === 0 &&
    path.length === 0 &&
    typing.arena.get(typing.arena.unfoldRecursive(type)).kind === "borrowed"
  ) {
    return "external";
  }
  if (
    relevant.some(
      (origin) =>
        origin.parameter === EXTERNAL_STORAGE_PARAMETER &&
        (origin.fresh !== true || origin.borrowed === true),
    )
  ) {
    return "external";
  }
  return relevant.some(
    (origin) => origin.parameter !== EXTERNAL_STORAGE_PARAMETER,
  )
    ? "parameter"
    : "none";
};

const nominalResultType = (
  type: TypeId | undefined,
  typing: TypingResult,
): TypeId | undefined => {
  if (typeof type !== "number") {
    return undefined;
  }
  const descriptor = typing.arena.get(type);
  if (descriptor.kind === "nominal-object") {
    return type;
  }
  return descriptor.kind === "intersection" ? descriptor.nominal : undefined;
};

const projectionsStartWith = (
  path: readonly PlaceProjection[],
  prefix: readonly PlaceProjection[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(path[index]),
  );

const traitRegionResultPath = ({
  result,
  mapped,
  region,
}: {
  result: readonly PlaceProjection[];
  mapped: readonly PlaceProjection[];
  region: PlaceProjection;
}): readonly PlaceProjection[] | undefined => {
  if (projectionsStartWith(result, mapped)) {
    return [region, ...result.slice(mapped.length)];
  }
  const mappedStorage =
    mapped.at(-1)?.kind === "dereference" ? mapped.slice(0, -1) : undefined;
  return mappedStorage && projectionsStartWith(result, mappedStorage)
    ? [region, ...result.slice(mappedStorage.length)]
    : undefined;
};

const flowProjectedThroughReturnedTrait = (
  flow: Flow,
  returnType: TypeId | undefined,
  ctx: SummaryContext,
): MutableFlow => {
  return unionFlows(
    ...Array.from(flow.values()).map((origin) => {
      if (typeof origin.resultNominal !== "number") {
        return new Map([[originKey(origin), origin]]);
      }
      const projected = traitRegionProjectionsForCoercion({
        sourceType: origin.resultNominal,
        targetType: returnType,
        hir: ctx.hir,
        typing: ctx.typing,
        symbolTable: ctx.symbolTable,
        moduleId: ctx.moduleId,
        imports: ctx.imports,
        dependencies: ctx.dependencies,
      }).flatMap(({ source, result }) => {
        if (origin.resultProjections.length === 0) {
          return [
            {
              ...origin,
              sourceProjections: [...origin.sourceProjections, ...source],
              resultProjections: [result],
            },
          ];
        }
        const resultProjections = traitRegionResultPath({
          result: origin.resultProjections,
          mapped: source,
          region: result,
        });
        return resultProjections ? [{ ...origin, resultProjections }] : [];
      });
      return projected.length > 0
        ? new Map(projected.map((entry) => [originKey(entry), entry]))
        : new Map([[originKey(origin), origin]]);
    }),
  );
};

const parameterFlowForPattern = ({
  parameter,
  pattern,
  typing,
  projections = [],
}: {
  parameter: number;
  pattern: HirPattern;
  typing: TypingResult;
  projections?: readonly PlaceProjection[];
}): MutableFlow => {
  if (pattern.kind === "identifier") {
    const typeId = typing.valueTypes.get(pattern.symbol);
    const path = projections;
    const origin = {
      parameter,
      sourceEndpointAccess:
        typeof typeId === "number" &&
        typing.arena.get(typeId).kind === "fixed-array"
          ? ("dereferenced" as const)
          : ("inline" as const),
      sourceProjections: path,
      resultProjections: path,
    };
    return new Map([[originKey(origin), origin]]);
  }
  if (pattern.kind === "tuple") {
    return unionFlows(
      ...pattern.elements.map((element, index) =>
        parameterFlowForPattern({
          parameter,
          pattern: element,
          typing,
          projections: [...projections, { kind: "tuple", index }],
        }),
      ),
    );
  }
  if (pattern.kind === "destructure") {
    return unionFlows(
      ...pattern.fields.map((entry) =>
        parameterFlowForPattern({
          parameter,
          pattern: entry.pattern,
          typing,
          projections: [...projections, { kind: "field", name: entry.name }],
        }),
      ),
      ...(pattern.spread
        ? [
            parameterFlowForPattern({
              parameter,
              pattern: pattern.spread,
              typing,
              projections,
            }),
          ]
        : []),
    );
  }
  if (pattern.kind === "type" && pattern.binding) {
    return parameterFlowForPattern({
      parameter,
      pattern: pattern.binding,
      typing,
      projections,
    });
  }
  return emptyFlow();
};

const externalModuleBindingFlows = (
  hir: HirGraph,
  typing: TypingResult,
  imports: ReadonlyMap<SymbolId, SymbolRef>,
  dependencies: ReadonlyMap<string, BorrowingDependency>,
): ReadonlyMap<SymbolId, Flow> =>
  new Map(
    [
      ...Array.from(hir.items.values()).flatMap((item) =>
        item.kind === "module-let" ? [item.symbol] : [],
      ),
      ...Array.from(imports).flatMap(([local, target]) => {
        const dependency = dependencies.get(target.moduleId);
        return dependency?.callables.has(target.symbol) ||
          dependency?.effectOperations.has(target.symbol)
          ? []
          : [local];
      }),
    ].flatMap((symbol) => {
      const type = typing.valueTypes.get(symbol);
      if (typeof type !== "number" || !typeCanCarryReference(type, typing)) {
        return [];
      }
      const origins = referenceOriginsInType(type, typing).map((reference) => {
        const origin: ParameterOrigin = {
          parameter: EXTERNAL_STORAGE_PARAMETER,
          sourceEndpointAccess: reference.endpointAccess,
          sourceProjections: reference.path,
          resultProjections: reference.path,
        };
        return [originKey(origin), origin] as const;
      });
      return [[symbol, new Map(origins)] as const];
    }),
  );

const addOrigin = (flow: MutableFlow, origin: ParameterOrigin): void => {
  const state = flowWideningState(flow);
  const familyKey = flowOriginFamilyKey(origin);
  if (
    origin.sourceProjections.length > MAX_FLOW_PROJECTION_DEPTH ||
    origin.resultProjections.length > MAX_FLOW_PROJECTION_DEPTH ||
    (origin.accessTypeComparator?.sourceProjections.length ?? 0) >
      MAX_FLOW_PROJECTION_DEPTH
  ) {
    addBroadOrigin(flow, origin);
  } else if (!state.broadFamilies.has(familyKey)) {
    const key = originKey(origin);
    if (!flow.has(key)) {
      flow.set(key, origin);
      state.parameterCounts.set(
        origin.parameter,
        (state.parameterCounts.get(origin.parameter) ?? 0) + 1,
      );
    }
  }
  if (
    (state.parameterCounts.get(origin.parameter) ?? 0) >
    MAX_FLOW_PATHS_PER_PARAMETER
  ) {
    const parameterOrigins = Array.from(flow.values()).filter(
      (candidate) => candidate.parameter === origin.parameter,
    );
    parameterOrigins.forEach((candidate) => addBroadOrigin(flow, candidate));
  }
};

const retainOrigin = (origin: ParameterOrigin, ctx: SummaryContext): void => {
  addOrigin(ctx.retained, origin);
  if (origin.borrowed === true || origin.shared === true) {
    addOrigin(ctx.borrowedRetained, origin);
  }
};

const recordAccess = (flow: Flow, ctx: SummaryContext): void => {
  flow.forEach((origin) => addOrigin(ctx.accessed, origin));
};

const recordWrite = (flow: Flow, ctx: SummaryContext): void => {
  flow.forEach((origin) => {
    addOrigin(ctx.written, origin);
    addOrigin(ctx.uncheckedWritten, origin);
  });
};

const retainOriginExternally = (
  origin: ParameterOrigin,
  ctx: SummaryContext,
): void => {
  addOrigin(ctx.externalRetained, origin);
  if (origin.borrowed === true || origin.shared === true) {
    addOrigin(ctx.borrowedRetained, origin);
  }
};

const unionFlows = (...flows: readonly Flow[]): MutableFlow => {
  const result = emptyFlow();
  flows.forEach((flow) => flow.forEach((origin) => addOrigin(result, origin)));
  return result;
};

const scopedTypeConditionId = (
  callExprId: HirExprId,
  conditionId: string,
): string => `${callExprId}:${conditionId}`;

const intersectFlows = (flows: readonly Flow[]): MutableFlow => {
  const [first, ...remaining] = flows;
  return new Map(
    Array.from(first ?? emptyFlow()).filter(([key]) =>
      remaining.every((flow) => flow.has(key)),
    ),
  );
};

const originWasInvalidated = (
  origin: ParameterOrigin,
  invalidated: Flow,
): boolean =>
  Array.from(invalidated.values()).some(
    (candidate) =>
      candidate.parameter === origin.parameter &&
      candidate.sourceProjections.length <= origin.sourceProjections.length &&
      candidate.sourceProjections.every(
        (projection, index) =>
          JSON.stringify(projection) ===
          JSON.stringify(origin.sourceProjections[index]),
      ),
  );

const cloneEnv = (env: MutableEnv, ctx: SummaryContext): MutableEnv => {
  const clone = new Map(env);
  ctx.invalidated.set(clone, new Map(ctx.invalidated.get(env) ?? emptyFlow()));
  ctx.placeEnvs.set(clone, new Map(ctx.placeEnvs.get(env) ?? []));
  ctx.expressionFlows.set(clone, new Map(ctx.expressionFlows.get(env) ?? []));
  return clone;
};

const mergeEnvs = (
  target: MutableEnv,
  sources: readonly MutableEnv[],
  ctx: SummaryContext,
): void => {
  const symbols = new Set(
    sources.flatMap((source) => Array.from(source.keys())),
  );
  symbols.forEach((symbol) => {
    const merged = unionFlows(
      ...sources.map((source) => source.get(symbol) ?? emptyFlow()),
    );
    if (merged.size > 0) target.set(symbol, merged);
    else target.delete(symbol);
  });
  ctx.invalidated.set(
    target,
    intersectFlows(
      sources.map((source) => ctx.invalidated.get(source) ?? emptyFlow()),
    ),
  );
  const placeSymbols = new Set(
    sources.flatMap((source) =>
      Array.from(ctx.placeEnvs.get(source)?.keys() ?? []),
    ),
  );
  ctx.placeEnvs.set(
    target,
    new Map(
      Array.from(placeSymbols, (symbol) => [
        symbol,
        unionFlows(
          ...sources.map(
            (source) => ctx.placeEnvs.get(source)?.get(symbol) ?? emptyFlow(),
          ),
        ),
      ]),
    ),
  );
  const expressions = new Set(
    sources.flatMap((source) =>
      Array.from(ctx.expressionFlows.get(source)?.keys() ?? []),
    ),
  );
  ctx.expressionFlows.set(
    target,
    new Map(
      Array.from(expressions, (exprId) => [
        exprId,
        unionFlows(
          ...sources.map(
            (source) =>
              ctx.expressionFlows.get(source)?.get(exprId) ?? emptyFlow(),
          ),
        ),
      ]),
    ),
  );
};

const widenedLoopFlow = (flow: Flow): MutableFlow =>
  new Map(
    Array.from(flow.values(), (origin) => {
      const widened =
        origin.sourceProjections.length > MAX_FLOW_PROJECTION_DEPTH ||
        origin.resultProjections.length > MAX_FLOW_PROJECTION_DEPTH
          ? {
              ...origin,
              sourceProjections: [],
              resultProjections: [],
            }
          : origin;
      return [originKey(widened), widened] as const;
    }),
  );

const widenLoopEnvironment = (
  environment: MutableEnv,
  ctx: SummaryContext,
): void => {
  environment.forEach((flow, symbol) =>
    environment.set(symbol, widenedLoopFlow(flow)),
  );
  const places = ctx.placeEnvs.get(environment);
  places?.forEach((flow, symbol) => places.set(symbol, widenedLoopFlow(flow)));
  ctx.invalidated.set(
    environment,
    widenedLoopFlow(ctx.invalidated.get(environment) ?? emptyFlow()),
  );
};

const environmentStateKey = (
  environment: MutableEnv,
  ctx: SummaryContext,
): string => {
  const keyedFlows = (
    entries: Iterable<readonly [SymbolId, Flow]>,
  ): readonly (readonly [SymbolId, readonly string[]])[] =>
    Array.from(
      entries,
      ([symbol, flow]) => [symbol, Array.from(flow.keys()).sort()] as const,
    ).sort(([left], [right]) => left - right);
  return JSON.stringify([
    keyedFlows(environment),
    keyedFlows(ctx.placeEnvs.get(environment) ?? []),
    Array.from(
      ctx.expressionFlows.get(environment) ?? [],
      ([exprId, flow]) => [exprId, Array.from(flow.keys()).sort()] as const,
    ).sort(([left], [right]) => left - right),
    Array.from(ctx.invalidated.get(environment)?.keys() ?? []).sort(),
  ]);
};

const bindPattern = (
  pattern: HirPattern,
  flow: Flow,
  env: MutableEnv,
): void => {
  switch (pattern.kind) {
    case "identifier":
      if (flow.size > 0) env.set(pattern.symbol, new Map(flow));
      else env.delete(pattern.symbol);
      return;
    case "tuple":
      pattern.elements.forEach((entry, index) =>
        bindPattern(entry, projectFlow(flow, [{ kind: "tuple", index }]), env),
      );
      return;
    case "destructure":
      pattern.fields.forEach((entry) =>
        bindPattern(
          entry.pattern,
          projectFlow(flow, [{ kind: "field", name: entry.name }]),
          env,
        ),
      );
      if (pattern.spread) {
        bindPattern(pattern.spread, flow, env);
      }
      return;
    case "type":
      if (pattern.binding) {
        bindPattern(pattern.binding, flow, env);
      }
      return;
    case "wildcard":
      return;
  }
};

const projectFlow = (
  flow: Flow,
  projections: readonly PlaceProjection[],
): MutableFlow => {
  let result = new Map(flow);
  projections.forEach((projection) => {
    const projected = emptyFlow();
    result.forEach((origin) => {
      if (origin.resultProjections.length === 0) {
        addOrigin(projected, {
          ...origin,
          sourceProjections: [...origin.sourceProjections, projection],
        });
        return;
      }
      const [next, ...remaining] = origin.resultProjections;
      if (next && projectionsOverlap(next, projection)) {
        addOrigin(projected, {
          ...origin,
          resultProjections: remaining,
        });
      }
    });
    result = projected;
  });
  return result;
};

const instantiateDefaultOrigin = (
  flow: Flow,
  origin: DefaultBorrowOrigin,
): MutableFlow =>
  new Map(
    Array.from(projectFlow(flow, origin.source).values(), (entry) => {
      const instantiated = {
        ...entry,
        sourceEndpointAccess:
          origin.endpointAccess ?? entry.sourceEndpointAccess,
        resultProjections: [...origin.result, ...entry.resultProjections],
      };
      return [originKey(instantiated), instantiated];
    }),
  );

const projectSemanticAllocationFlow = (
  flow: Flow,
  path: readonly PlaceProjection[],
): MutableFlow =>
  new Map(
    Array.from(flow.values()).flatMap((origin) => {
      const resultPath = origin.resultProjections;
      if (resultPath.length > path.length) {
        return [];
      }
      const matchesResult = resultPath.every((projection, index) =>
        projectionsOverlap(projection, path[index]!),
      );
      const remaining = path.slice(resultPath.length);
      if (!matchesResult) {
        return [];
      }
      const sourceSuffix =
        resultPath.length > 0 &&
        remaining[0]?.kind === "dereference" &&
        origin.sourceEndpointAccess === "inline"
          ? remaining.slice(1)
          : remaining;
      const crossesAllocation = remaining.some(
        (projection) => projection.kind === "dereference",
      );
      if (!crossesAllocation) {
        return [];
      }
      const projected = {
        ...origin,
        sourceProjections: [...origin.sourceProjections, ...sourceSuffix],
        resultProjections: [],
      };
      return [[originKey(projected), projected] as const];
    }),
  );

const projectAccessFlow = (
  flow: Flow,
  exprId: HirExprId,
  projection: PlaceProjection,
  ctx: SummaryContext,
): MutableFlow =>
  unionFlows(
    ...Array.from(flow.values()).map((origin) =>
      projectFlow(
        new Map([[originKey(origin), origin]]),
        accessProjectionsFor(
          exprId,
          projection,
          ctx,
          origin.sourceProjections.length > 0,
        ),
      ),
    ),
  );

const storeFlowAt = (flow: Flow, projection: PlaceProjection): MutableFlow =>
  unionFlows(
    new Map(
      Array.from(flow.values(), (origin) => {
        const stored = {
          ...origin,
          resultProjections: [projection, ...origin.resultProjections],
        };
        return [originKey(stored), stored];
      }),
    ),
  );

const storeFlowAtPath = (
  flow: Flow,
  projections: readonly PlaceProjection[],
): MutableFlow =>
  projections.reduceRight(
    (stored, projection) => storeFlowAt(stored, projection),
    new Map(flow),
  );

const replaceFlowAtPath = (
  current: Flow,
  value: Flow,
  projections: readonly PlaceProjection[],
): MutableFlow =>
  unionFlows(
    new Map(
      Array.from(current).filter(
        ([, origin]) =>
          !projectionPathCovers(projections, origin.resultProjections),
      ),
    ),
    storeFlowAtPath(value, projections),
  );

const contractPaths = (
  parameter: CallableParameterBorrowContract,
  kind: "retained" | "returned",
): readonly (readonly PlaceProjection[])[] => {
  const paths =
    kind === "retained" ? parameter.retainedPaths : parameter.returnedPaths;
  return paths && paths.length > 0 ? paths : [[]];
};

const returnedFlowForParameter = (
  parameter: CallableParameterBorrowContract,
  flow: Flow,
  callExprId: HirExprId,
  borrowedResultPaths: readonly (readonly PlaceProjection[])[],
  usesDefault = false,
): MutableFlow => {
  if (!parameter.returned) {
    return emptyFlow();
  }
  const result = emptyFlow();
  const origins: readonly ReturnedBorrowOrigin[] =
    parameter.returnedOrigins && parameter.returnedOrigins.length > 0
      ? parameter.returnedOrigins
      : contractPaths(parameter, "returned").map((source) => ({
          source,
          result: [],
        }));
  const returnedOriginKey = (origin: ReturnedBorrowOrigin): string =>
    JSON.stringify([
      origin.source,
      origin.result,
      origin.endpointAccess ?? "inline",
    ]);
  origins.forEach((contractOrigin) => {
    const defaultSuppressesBorrowAtResult =
      usesDefault &&
      parameter.returnedSharedOrigins?.some(
        (candidate) =>
          candidate.defaultNoBorrow === true &&
          (projectionPathCovers(candidate.result, contractOrigin.result) ||
            projectionPathCovers(contractOrigin.result, candidate.result)),
      ) === true;
    const returnedShared =
      parameter.returnedSharedOrigins?.some(
        (sharedOrigin) =>
          returnedOriginKey(sharedOrigin) === returnedOriginKey(contractOrigin),
      ) === true;
    const returnsExplicitBorrow = borrowedResultPaths.some((borrowedPath) =>
      projectionPathCovers(borrowedPath, contractOrigin.result),
    );
    const typeCondition = parameter.returnedTypeMatchingOrigins?.find(
      (conditionalOrigin) =>
        JSON.stringify(conditionalOrigin.source) ===
          JSON.stringify(contractOrigin.source) &&
        JSON.stringify(conditionalOrigin.result) ===
          JSON.stringify(contractOrigin.result) &&
        conditionalOrigin.endpointAccess === contractOrigin.endpointAccess,
    );
    projectFlow(flow, contractOrigin.source).forEach((origin) => {
      if (
        defaultSuppressesBorrowAtResult &&
        (origin.borrowed === true || origin.shared === true)
      ) {
        return;
      }
      const materializedOrigin =
        returnedShared || returnsExplicitBorrow
          ? origin
          : (() => {
              const { borrowed: _borrowed, shared: _shared, ...plain } = origin;
              return plain;
            })();
      addOrigin(result, {
        ...materializedOrigin,
        sourceEndpointAccess:
          contractOrigin.endpointAccess ?? origin.sourceEndpointAccess,
        ...(returnedShared && !defaultSuppressesBorrowAtResult
          ? { shared: true }
          : {}),
        ...(typeCondition
          ? {
              returnTypeConditionId: scopedTypeConditionId(
                callExprId,
                typeCondition.conditionId,
              ),
            }
          : {}),
        resultProjections: [
          ...contractOrigin.result,
          ...origin.resultProjections,
        ],
      });
    });
  });
  return result;
};

const patternSymbols = (pattern: HirPattern): SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(patternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((entry) => patternSymbols(entry.pattern)),
        ...(pattern.spread ? patternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? patternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const mutablePatternSymbols = (pattern: HirPattern): SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return pattern.bindingKind === "mutable-ref" ? [pattern.symbol] : [];
    case "tuple":
      return pattern.elements.flatMap(mutablePatternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((entry) =>
          mutablePatternSymbols(entry.pattern),
        ),
        ...(pattern.spread ? mutablePatternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? mutablePatternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const placeOfExpression = (
  exprId: HirExprId,
  ctx: SummaryContext,
): { root: SymbolId; projections: readonly PlaceProjection[] } | undefined => {
  const placeId = ctx.facts.placeForExpression.get(exprId);
  const place = placeId === undefined ? undefined : ctx.facts.places[placeId];
  return place
    ? { root: place.root, projections: place.projections }
    : undefined;
};

const physicalFlowOfExpression = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
  seen = new Set<SymbolId>(),
  cache = new Map<string, Flow>(),
): MutableFlow => {
  const cacheKey = `${exprId}:${Array.from(seen)
    .sort((left, right) => left - right)
    .join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    incrementCompilerPerfCounter("borrowing.summary.physicalFlowCacheHits");
    return new Map(cached);
  }
  const finish = (flow: MutableFlow): MutableFlow => {
    cache.set(cacheKey, flow);
    return new Map(flow);
  };
  const place = placeOfExpression(exprId, ctx);
  if (place) {
    const known = ctx.placeEnvs.get(env)?.get(place.root);
    if (known) {
      const rootType = ctx.typing.valueTypes.get(place.root);
      const allocationBackedRoot =
        typeof rootType === "number" &&
        typeIsAllocationBacked(rootType, ctx.typing);
      return finish(
        unionFlows(
          ...Array.from(known.values()).map((origin) =>
            projectFlow(
              new Map([[originKey(origin), origin]]),
              allocationBackedRoot && origin.sourceProjections.length > 0
                ? [{ kind: "dereference" }, ...place.projections]
                : place.projections,
            ),
          ),
        ),
      );
    }
    const parameterFlow = ctx.parameterSymbolFlows.get(place.root);
    if (parameterFlow) {
      return finish(projectFlow(parameterFlow, place.projections));
    }
    const initializer = ctx.bindingInitializers.get(place.root);
    if (typeof initializer !== "number" || seen.has(place.root)) {
      return finish(emptyFlow());
    }
    seen.add(place.root);
    return finish(
      projectFlow(
        physicalFlowOfExpression(initializer, env, ctx, seen, cache),
        place.projections,
      ),
    );
  }
  const expression = summaryExpression(exprId, ctx);
  if (
    expression?.exprKind !== "call" &&
    expression?.exprKind !== "method-call"
  ) {
    return finish(emptyFlow());
  }
  const resolved = resolvedBorrowCallFromFacts(expression, ctx);
  return finish(
    unionFlows(
      ...(resolved.contract?.parameters.flatMap((parameter, index) => {
        if (!parameter.returned) {
          return [];
        }
        const actual = resolved.arguments[index];
        if (typeof actual !== "number") {
          return [];
        }
        const origins =
          parameter.returnedOrigins && parameter.returnedOrigins.length > 0
            ? parameter.returnedOrigins
            : (parameter.returnedPaths && parameter.returnedPaths.length > 0
                ? parameter.returnedPaths
                : [[]]
              ).map((source) => ({ source, result: [] }));
        return origins
          .filter((origin) => origin.result.length === 0)
          .map((origin) =>
            projectFlow(
              physicalFlowOfExpression(actual, env, ctx, new Set(seen), cache),
              origin.source,
            ),
          );
      }) ?? []),
    ),
  );
};

const explicitBorrowedResultFlow = (
  exprId: HirExprId,
  borrowedPaths: readonly (readonly PlaceProjection[])[],
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow =>
  unionFlows(
    ...borrowedPaths.map((path) =>
      storeFlowAtPath(
        unionFlows(
          ...factValueRequests({
            facts: ctx.facts,
            expression: exprId,
            requested: path,
          }).map(({ expression, requested }) =>
            projectFlow(
              physicalFlowOfExpression(expression, env, ctx),
              requested,
            ),
          ),
        ),
        path,
      ),
    ),
  );

const directPlaceFlowOfExpression = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const place = placeOfExpression(exprId, ctx);
  if (!place) {
    return emptyFlow();
  }
  const known = ctx.placeEnvs.get(env)?.get(place.root);
  if (known) {
    const rootType = ctx.typing.valueTypes.get(place.root);
    const allocationBackedRoot =
      typeof rootType === "number" &&
      typeIsAllocationBacked(rootType, ctx.typing);
    return unionFlows(
      ...Array.from(known.values()).map((origin) =>
        projectFlow(
          new Map([[originKey(origin), origin]]),
          allocationBackedRoot && origin.sourceProjections.length > 0
            ? [{ kind: "dereference" }, ...place.projections]
            : place.projections,
        ),
      ),
    );
  }
  const parameterFlow = ctx.parameterSymbolFlows.get(place.root);
  return parameterFlow === undefined
    ? emptyFlow()
    : projectFlow(parameterFlow, place.projections);
};

const recordTransfer = (
  transfer: CallableBorrowTransfer,
  ctx: SummaryContext,
): void => {
  ctx.transfers.set(JSON.stringify(transfer), transfer);
};

const recordTransfersInto = ({
  destination,
  destinationSuffix = [],
  source,
  sourceInvalidated = false,
  ctx,
}: {
  destination: Flow;
  destinationSuffix?: readonly PlaceProjection[];
  source: Flow;
  sourceInvalidated?: boolean;
  ctx: SummaryContext;
}): void => {
  destination.forEach((destinationOrigin) =>
    source.forEach((sourceOrigin) => {
      if (sourceOrigin.parameter < 0 || destinationOrigin.parameter < 0) {
        return;
      }
      const sourcePath = sourceOrigin.sourceProjections;
      const destinationBasePath = [
        ...destinationOrigin.sourceProjections,
        ...destinationSuffix,
      ];
      const destinationPath = [
        ...destinationBasePath,
        ...sourceOrigin.resultProjections,
      ];
      const sourceWasInvalidated =
        sourceInvalidated ||
        (sourceOrigin.parameter === destinationOrigin.parameter &&
          destinationBasePath.length < sourcePath.length &&
          destinationBasePath.every(
            (projection, index) =>
              JSON.stringify(projection) === JSON.stringify(sourcePath[index]),
          ));
      recordTransfer(
        {
          sourceParameter: sourceOrigin.parameter,
          destinationParameter: destinationOrigin.parameter,
          sourcePath,
          destinationPath,
          ...(sourceWasInvalidated ? { sourceInvalidated: true } : {}),
        },
        ctx,
      );
    }),
  );
};

const targetMaySuspend = (
  target: SymbolRef | undefined,
  resolved: ResolvedBorrowCall,
  ctx: SummaryContext,
  callee?: HirExprId,
): boolean => {
  const contract =
    target?.moduleId === ctx.moduleId
      ? ctx.contracts.get(target.symbol)
      : target
        ? ctx.dependencies.get(target.moduleId)?.callables.get(target.symbol)
            ?.contract
        : resolved.contract;
  if (contract) {
    return contract.maySuspend;
  }
  if (target) {
    if (target.moduleId === ctx.moduleId) {
      const operation = ctx.decls.getEffectOperation(target.symbol);
      if (operation) {
        return operation.operation.resumable === "resume";
      }
    } else {
      const operation = ctx.dependencies
        .get(target.moduleId)
        ?.effectOperations.get(target.symbol);
      if (operation) {
        return operation.maySuspend;
      }
    }
  }
  if (typeof callee !== "number") {
    return false;
  }
  const calleeType =
    ctx.typing.resolvedExprTypes.get(callee) ??
    ctx.typing.table.getExprType(callee);
  if (typeof calleeType !== "number") {
    return false;
  }
  const descriptor = ctx.typing.arena.get(calleeType);
  return (
    descriptor.kind === "function" &&
    !ctx.typing.effects.isEmpty(descriptor.effectRow)
  );
};

const applyCallContract = ({
  contract,
  args,
  argExprs,
  callExprId,
  env,
  ctx,
}: {
  contract: CallableBorrowContract | undefined;
  args: readonly Flow[];
  argExprs: readonly (HirExprId | undefined)[];
  callExprId: HirExprId;
  env: MutableEnv;
  ctx: SummaryContext;
}): MutableFlow => {
  if (!contract) {
    return emptyFlow();
  }
  const result = emptyFlow();
  const callResultType = summaryExpressionTypeFor(callExprId, ctx);
  const borrowedResultPaths =
    typeof callResultType === "number"
      ? borrowedPathsInType(callResultType, ctx.typing)
      : [];
  const externalOrigin = ({
    resultProjections = [],
    endpointAccess = "inline",
    fresh = false,
  }: {
    resultProjections?: readonly PlaceProjection[];
    endpointAccess?: ParameterOrigin["sourceEndpointAccess"];
    fresh?: boolean;
  } = {}): ParameterOrigin => ({
    parameter: EXTERNAL_STORAGE_PARAMETER,
    sourceEndpointAccess: endpointAccess,
    sourceProjections: [],
    resultProjections,
    ...(fresh ? { fresh: true } : {}),
  });
  if (contract.externalRead) {
    addOrigin(ctx.accessed, externalOrigin());
  }
  if (contract.externalWrite) {
    addOrigin(ctx.written, externalOrigin());
  }
  const effectiveParameterFlows: (Flow | undefined)[] = [];
  const effectiveFlowForParameter = (
    index: number,
    seen = new Set<number>(),
  ): Flow => {
    const cached = effectiveParameterFlows[index];
    if (cached) {
      return cached;
    }
    if (seen.has(index)) {
      return emptyFlow();
    }
    seen.add(index);
    const parameter = contract.parameters[index];
    const flow =
      typeof argExprs[index] === "number"
        ? (args[index] ?? emptyFlow())
        : unionFlows(
            ...(parameter?.defaultOrigins ?? []).map((origin) =>
              instantiateDefaultOrigin(
                effectiveFlowForParameter(origin.parameter, new Set(seen)),
                origin,
              ),
            ),
            ...(parameter?.defaultExternalOrigins ?? []).map((origin) => {
              const external = externalOrigin({
                resultProjections: origin.result,
                endpointAccess: origin.endpointAccess,
                fresh: origin.fresh === true,
              });
              return new Map([[originKey(external), external]]);
            }),
          );
    effectiveParameterFlows[index] = flow;
    return flow;
  };
  const effectiveFlows = contract.parameters.map((_parameter, index) =>
    effectiveFlowForParameter(index),
  );
  const mutableDestinations = unionFlows(
    ...(contract.transfers?.map(
      (transfer) =>
        effectiveFlows[transfer.destinationParameter] ?? emptyFlow(),
    ) ?? []),
  );
  const mutableDestinationParameters = new Set(
    Array.from(mutableDestinations.values(), (origin) => origin.parameter),
  );
  const retainedOnlyInLocalDestinations = (parameter: number): boolean => {
    const transfers =
      contract.transfers?.filter(
        (transfer) => transfer.sourceParameter === parameter,
      ) ?? [];
    return (
      transfers.length > 0 &&
      transfers.every((transfer) => {
        const destinationExpr = argExprs[transfer.destinationParameter];
        if (typeof destinationExpr !== "number") {
          return false;
        }
        const destination = placeOfExpression(destinationExpr, ctx);
        return (
          destination !== undefined && ctx.localOwnedRoots.has(destination.root)
        );
      })
    );
  };
  contract.parameters.forEach((parameter, index) => {
    if (typeof argExprs[index] !== "number") {
      if (parameter.defaultExternalRead) {
        addOrigin(ctx.accessed, externalOrigin());
      }
      if (parameter.defaultExternalWrite) {
        addOrigin(ctx.written, externalOrigin());
      }
    }
    const applyDefaultAccessOrigins = (
      origins: readonly DefaultBorrowAccessOrigin[] | undefined,
      destination: MutableFlow,
    ): void => {
      if (typeof argExprs[index] === "number") {
        return;
      }
      origins?.forEach((origin) => {
        const sourceFlow = effectiveFlows[origin.parameter] ?? emptyFlow();
        const sourceExpr = argExprs[origin.parameter];
        const directSourceFlow =
          typeof sourceExpr === "number"
            ? directPlaceFlowOfExpression(sourceExpr, env, ctx)
            : emptyFlow();
        unionFlows(
          projectFlow(directSourceFlow, origin.path),
          projectSemanticAllocationFlow(sourceFlow, origin.path),
        ).forEach((projectedOrigin) => addOrigin(destination, projectedOrigin));
      });
    };
    applyDefaultAccessOrigins(parameter.defaultReadOrigins, ctx.accessed);
    applyDefaultAccessOrigins(parameter.defaultWriteOrigins, ctx.written);
    if (parameter.runtimeCheckedWrites !== true) {
      applyDefaultAccessOrigins(
        parameter.defaultWriteOrigins,
        ctx.uncheckedWritten,
      );
    }
    const flow = effectiveFlows[index] ?? emptyFlow();
    // Owned values can still have a compact read/write footprint. Access
    // paths describe the operation performed on the value; ownership only
    // controls retention and returned provenance below.
    {
      const actual = argExprs[index];
      const directPlaceFlow =
        typeof actual === "number"
          ? directPlaceFlowOfExpression(actual, env, ctx)
          : unionFlows(
              ...(parameter.defaultOrigins ?? []).map((origin) => {
                const originExpr = argExprs[origin.parameter];
                return typeof originExpr === "number"
                  ? instantiateDefaultOrigin(
                      directPlaceFlowOfExpression(originExpr, env, ctx),
                      origin,
                    )
                  : emptyFlow();
              }),
            );
      const projectAccessFlowForPath = (
        path: readonly PlaceProjection[],
      ): MutableFlow => {
        const actualPlace =
          typeof actual === "number"
            ? placeOfExpression(actual, ctx)
            : undefined;
        const actualExpression =
          typeof actual === "number"
            ? summaryExpression(actual, ctx)
            : undefined;
        const actualIsCallableResult =
          actualExpression?.exprKind === "call" ||
          actualExpression?.exprKind === "method-call";
        const accessesOnlyLocalStorage =
          actualPlace !== undefined &&
          ctx.localOwnedRoots.has(actualPlace.root) &&
          !actualIsCallableResult &&
          path.some((projection) => projection.kind === "dereference") &&
          path.filter((projection) => projection.kind === "dereference")
            .length === 1;
        const projected = unionFlows(
          projectFlow(directPlaceFlow, path),
          projectSemanticAllocationFlow(flow, path),
          actualIsCallableResult ? projectFlow(flow, path) : emptyFlow(),
        );
        return accessesOnlyLocalStorage
          ? new Map(
              Array.from(projected).filter(
                ([, origin]) =>
                  origin.parameter === EXTERNAL_STORAGE_PARAMETER &&
                  origin.fresh === true,
              ),
            )
          : projected;
      };
      const accessCondition = parameter.accessIfResultTypeDiffers;
      const comparedFlow = accessCondition
        ? projectFlow(
            effectiveFlows[accessCondition.parameter] ?? emptyFlow(),
            accessCondition.sourcePath,
          )
        : emptyFlow();
      const comparedOrigins = Array.from(comparedFlow.values());
      const comparator =
        comparedOrigins.length === 1
          ? {
              parameter: comparedOrigins[0]!.parameter,
              sourceProjections: comparedOrigins[0]!.sourceProjections,
            }
          : undefined;
      const readPaths = parameter.readPaths ?? [];
      const writePaths = parameter.writePaths ?? [];
      readPaths.forEach((path) =>
        projectAccessFlowForPath(path).forEach((origin) =>
          addOrigin(ctx.accessed, {
            ...origin,
            ...(accessCondition && comparator
              ? {
                  accessTypeComparator: {
                    ...comparator,
                    conditionId: scopedTypeConditionId(
                      callExprId,
                      accessCondition.conditionId,
                    ),
                  },
                }
              : {}),
          }),
        ),
      );
      writePaths.forEach((path) =>
        projectAccessFlowForPath(path).forEach((origin) => {
          addOrigin(ctx.written, origin);
          if (parameter.runtimeCheckedWrites !== true) {
            addOrigin(ctx.uncheckedWritten, origin);
          }
        }),
      );
    }
    if (parameter.retained && !retainedOnlyInLocalDestinations(index)) {
      contractPaths(parameter, "retained").forEach((path) =>
        projectFlow(flow, path).forEach((origin) => {
          if (!mutableDestinationParameters.has(origin.parameter)) {
            retainOrigin(
              parameter.retainedUnlessBorrowed
                ? { ...origin, retainedUnlessBorrowed: true }
                : origin,
              ctx,
            );
          }
        }),
      );
    }
    parameter.externalRetainedPaths?.forEach((path) =>
      projectFlow(flow, path).forEach((origin) =>
        retainOriginExternally(
          parameter.retainedUnlessBorrowed
            ? { ...origin, retainedUnlessBorrowed: true }
            : origin,
          ctx,
        ),
      ),
    );
    parameter.borrowedRetainedPaths?.forEach((path) =>
      projectFlow(flow, path).forEach((origin) =>
        addOrigin(ctx.borrowedRetained, origin),
      ),
    );
    if (parameter.returned) {
      returnedFlowForParameter(
        parameter,
        flow,
        callExprId,
        borrowedResultPaths,
        typeof argExprs[index] !== "number",
      ).forEach((origin) => addOrigin(result, origin));
    }
  });
  const invalidated = ctx.invalidated.get(env) ?? emptyFlow();
  contract.parameters.forEach((parameter, index) => {
    const actual = argExprs[index];
    if (typeof actual !== "number") {
      return;
    }
    parameter.invalidatedPaths?.forEach((path) => {
      const killed = projectFlow(
        physicalFlowOfExpression(actual, env, ctx),
        path,
      );
      if (killed.size === 1) {
        killed.forEach((origin) =>
          addOrigin(invalidated, {
            ...origin,
            resultProjections: [],
          }),
        );
      }
    });
  });
  ctx.invalidated.set(env, invalidated);
  contract.transfers?.forEach((transfer) => {
    const transferred = applyTransfer({
      transfer,
      args: effectiveFlows,
      argExprs,
      env,
      ctx,
    });
    const destination = contract.parameters[transfer.destinationParameter];
    if (!destination) {
      return;
    }
    returnedFlowForParameter(
      destination,
      transferred,
      callExprId,
      borrowedResultPaths,
    ).forEach((origin) => addOrigin(result, origin));
  });
  const effectiveCallableOrigins = (
    parameterIndex: number,
    requested: readonly PlaceProjection[],
    seen = new Set<number>(),
  ): readonly CallableOrigin[] => {
    const callbackExpr = argExprs[parameterIndex];
    if (typeof callbackExpr === "number") {
      return callableOriginsOf(callbackExpr, ctx, new Set(), requested);
    }
    if (seen.has(parameterIndex)) {
      return [];
    }
    seen.add(parameterIndex);
    return (
      contract.parameters[parameterIndex]?.defaultOrigins?.flatMap((origin) => {
        const translated = translateProjectionPath({
          result: origin.result,
          source: origin.source,
          requested,
        });
        return translated === undefined
          ? []
          : effectiveCallableOrigins(
              origin.parameter,
              translated,
              new Set(seen),
            );
      }) ?? []
    );
  };
  contract.scopedCallbacks?.forEach((callback) => {
    const requested =
      callback.callbackPath?.map((part) =>
        Number.isInteger(Number(part))
          ? ({ kind: "tuple", index: Number(part) } as const)
          : ({ kind: "field", name: part } as const),
      ) ?? [];
    const callbackOrigins = effectiveCallableOrigins(
      callback.callbackParameter,
      requested,
    );
    callbackOrigins.forEach(({ origin, path }) => {
      const scoped: ScopedCallbackBorrowContract = {
        callbackParameter: origin,
        callbackValueParameter: callback.callbackValueParameter,
        access: callback.access,
        ...(path.length > 0 ? { callbackPath: path } : {}),
      };
      const key = `${origin}:${callback.callbackValueParameter}:${scoped.callbackPath?.join(".") ?? ""}`;
      const existing = ctx.scopedCallbacks.get(key);
      ctx.scopedCallbacks.set(key, {
        ...scoped,
        access:
          existing?.access === "mutable" || scoped.access === "mutable"
            ? "mutable"
            : "shared",
      });
    });
  });
  contract.externalReturnedOrigins?.forEach((origin) => {
    addOrigin(
      result,
      externalOrigin({
        resultProjections: origin.result,
        endpointAccess: origin.endpointAccess,
        fresh: origin.fresh === true,
      }),
    );
  });
  return result;
};

const applyTransfer = ({
  transfer,
  args,
  argExprs,
  env,
  ctx,
}: {
  transfer: CallableBorrowTransfer;
  args: readonly Flow[];
  argExprs: readonly (HirExprId | undefined)[];
  env: MutableEnv;
  ctx: SummaryContext;
}): MutableFlow => {
  const destinationExpr = argExprs[transfer.destinationParameter];
  const destination =
    typeof destinationExpr === "number"
      ? placeOfExpression(destinationExpr, ctx)
      : undefined;
  const sourceExpr = argExprs[transfer.sourceParameter];
  const sourceArgument = unionFlows(
    args[transfer.sourceParameter] ?? emptyFlow(),
    typeof sourceExpr === "number"
      ? physicalFlowOfExpression(sourceExpr, env, ctx)
      : emptyFlow(),
  );
  const source = transfer.conservative
    ? new Map(
        Array.from(sourceArgument.values(), (origin) => {
          const broadened = { ...origin, resultProjections: [] };
          return [originKey(broadened), broadened] as const;
        }),
      )
    : projectFlow(sourceArgument, transfer.sourcePath ?? []);
  const projectedSource = transfer.borrowsSource
    ? new Map(
        Array.from(source.values(), (origin) => {
          const borrowed = { ...origin, borrowed: true as const };
          return [originKey(borrowed), borrowed] as const;
        }),
      )
    : source;
  const destinationPath = transfer.conservative
    ? []
    : (transfer.destinationPath ?? []);
  const transferred = storeFlowAtPath(projectedSource, destinationPath);
  const stored = storeFlowAtPath(projectedSource, [
    ...(destination?.projections ?? []),
    ...destinationPath,
  ]);
  if (typeof destinationExpr !== "number" || stored.size === 0) {
    return emptyFlow();
  }
  const destinationPhysical = physicalFlowOfExpression(
    destinationExpr,
    env,
    ctx,
  );
  recordTransfersInto({
    destination: destinationPhysical,
    destinationSuffix: destinationPath,
    source: projectedSource,
    sourceInvalidated: transfer.sourceInvalidated,
    ctx,
  });
  if (!destination) {
    stored.forEach((origin) => retainOriginExternally(origin, ctx));
    return transferred;
  }
  env.set(
    destination.root,
    unionFlows(env.get(destination.root) ?? emptyFlow(), stored),
  );
  if (!ctx.localOwnedRoots.has(destination.root)) {
    const destinationRecord = ctx.symbolTable.getSymbol(destination.root);
    const destinationIsModule =
      ctx.symbolTable.getScope(destinationRecord.scope).kind === "module";
    const destinationParameters = new Set(
      Array.from(destinationPhysical.values(), (origin) => origin.parameter),
    );
    const destinationParameter = ctx.parameterOrigins.get(destination.root);
    if (destinationParameter !== undefined) {
      destinationParameters.add(destinationParameter);
    }
    stored.forEach((origin) => {
      if (!destinationParameters.has(origin.parameter)) {
        if (destinationIsModule) {
          retainOriginExternally(origin, ctx);
          return;
        }
        retainOrigin(origin, ctx);
      }
    });
  }
  return transferred;
};

type CallableOrigin = {
  origin: number;
  path: readonly string[];
};

const projectionPathNames = (
  projections: readonly PlaceProjection[],
): readonly string[] =>
  projections.flatMap((projection) =>
    projection.kind === "field"
      ? [projection.name]
      : projection.kind === "tuple"
        ? [String(projection.index)]
        : [],
  );

const callableOriginsOf = (
  exprId: HirExprId,
  ctx: SummaryContext,
  _seen = new Set<HirExprId>(),
  requested: readonly PlaceProjection[] = [],
): readonly CallableOrigin[] => {
  const pending = [{ expression: exprId, requested }];
  const origins: CallableOrigin[] = [];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const structural = factValueRequests({
      facts: ctx.facts,
      expression: current.expression,
      requested: current.requested,
      access: true,
    });
    structural.forEach((request) => {
      const key = `${request.expression}:${JSON.stringify(request.requested)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const expr = summaryExpression(request.expression, ctx);
      if (expr?.exprKind === "identifier") {
        const initializer = ctx.bindingInitializers.get(expr.symbol);
        if (typeof initializer === "number") {
          pending.push({
            expression: initializer,
            requested: request.requested,
          });
          return;
        }
        const origin = ctx.parameterOrigins.get(expr.symbol);
        if (typeof origin === "number") {
          origins.push({
            origin,
            path: projectionPathNames(request.requested),
          });
        }
        return;
      }
      if (expr?.exprKind !== "call" && expr?.exprKind !== "method-call") {
        return;
      }
      const resolved = resolvedBorrowCallFromFacts(expr, ctx);
      const effectiveCallableOriginsForParameter = (
        parameterIndex: number,
        parameterRequested: readonly PlaceProjection[],
        seenParameters = new Set<number>(),
      ): readonly CallableOrigin[] => {
        const actual = resolved.arguments[parameterIndex];
        if (typeof actual === "number") {
          pending.push({ expression: actual, requested: parameterRequested });
          return [];
        }
        if (seenParameters.has(parameterIndex)) {
          return [];
        }
        seenParameters.add(parameterIndex);
        return (
          resolved.contract?.parameters[
            parameterIndex
          ]?.defaultOrigins?.flatMap((origin) => {
            const translated = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: parameterRequested,
            });
            return translated === undefined
              ? []
              : effectiveCallableOriginsForParameter(
                  origin.parameter,
                  translated,
                  new Set(seenParameters),
                );
          }) ?? []
        );
      };
      resolved.contract?.parameters.forEach((parameter, index) => {
        if (!parameter.returned) {
          return;
        }
        const origins =
          parameter.returnedOrigins && parameter.returnedOrigins.length > 0
            ? parameter.returnedOrigins
            : (parameter.returnedPaths && parameter.returnedPaths.length > 0
                ? parameter.returnedPaths
                : [[]]
              ).map((source) => ({ source, result: [] }));
        origins.forEach((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested: request.requested,
          });
          if (translated)
            effectiveCallableOriginsForParameter(index, translated);
        });
      });
    });
  }
  return origins;
};

const callableContractOfExpression = ({
  exprId,
  ctx,
  resolveParameterDefault,
  requested = [],
  seen = new Set<HirExprId>(),
}: {
  exprId: HirExprId;
  ctx: SummaryContext;
  resolveParameterDefault?: (
    symbol: SymbolId,
    requested: readonly PlaceProjection[],
  ) => CallableBorrowContract | undefined;
  requested?: readonly PlaceProjection[];
  seen?: Set<HirExprId>;
}): CallableBorrowContract | undefined => {
  const pending = [{ expression: exprId, requested }];
  const contracts: CallableBorrowContract[] = [];
  const visited = new Set(Array.from(seen, (expression) => `${expression}:[]`));
  let unresolved = false;
  const enqueueDefaultExpressions = ({
    resolved,
    parameterIndex,
    parameterRequested,
    seenParameters = new Set<number>(),
  }: {
    resolved: ReturnType<typeof resolvedBorrowCallFromFacts>;
    parameterIndex: number;
    parameterRequested: readonly PlaceProjection[];
    seenParameters?: Set<number>;
  }): void => {
    const actual = resolved.arguments[parameterIndex];
    if (typeof actual === "number") {
      pending.push({ expression: actual, requested: parameterRequested });
      return;
    }
    if (seenParameters.has(parameterIndex)) {
      unresolved = true;
      return;
    }
    seenParameters.add(parameterIndex);
    const defaults =
      resolved.contract?.parameters[parameterIndex]?.defaultOrigins ?? [];
    if (defaults.length === 0) unresolved = true;
    defaults.forEach((origin) => {
      const translated = translateProjectionPath({
        result: origin.result,
        source: origin.source,
        requested: parameterRequested,
      });
      if (translated !== undefined) {
        enqueueDefaultExpressions({
          resolved,
          parameterIndex: origin.parameter,
          parameterRequested: translated,
          seenParameters: new Set(seenParameters),
        });
      }
    });
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    factValueRequests({
      facts: ctx.facts,
      expression: current.expression,
      requested: current.requested,
    }).forEach((request) => {
      const key = `${request.expression}:${JSON.stringify(request.requested)}`;
      if (visited.has(key)) return;
      visited.add(key);
      const expr = summaryExpression(request.expression, ctx);
      if (expr?.exprKind === "identifier") {
        const imported = ctx.imports.get(expr.symbol);
        const direct = imported
          ? ctx.dependencies
              .get(imported.moduleId)
              ?.callables.get(imported.symbol)?.contract
          : ctx.contracts.get(expr.symbol);
        if (request.requested.length === 0 && direct) {
          contracts.push(direct);
          return;
        }
        const initializer = ctx.bindingInitializers.get(expr.symbol);
        if (typeof initializer === "number") {
          pending.push({
            expression: initializer,
            requested: request.requested,
          });
          return;
        }
        const fallback = resolveParameterDefault?.(
          expr.symbol,
          request.requested,
        );
        if (fallback) contracts.push(fallback);
        else unresolved = true;
        return;
      }
      if (expr?.exprKind === "lambda" && request.requested.length === 0) {
        const lambdaFacts = ctx.lambdaFacts.get(expr.id);
        const contract = lambdaFacts
          ? ctx.contracts.get(lambdaFacts.symbol)
          : undefined;
        if (contract) contracts.push(contract);
        else unresolved = true;
        return;
      }
      if (expr?.exprKind !== "call" && expr?.exprKind !== "method-call") {
        unresolved = true;
        return;
      }
      const resolved = resolvedBorrowCallFromFacts(expr, ctx);
      let returned = false;
      resolved.contract?.parameters.forEach((parameter, index) => {
        if (!parameter.returned) return;
        const origins =
          parameter.returnedOrigins && parameter.returnedOrigins.length > 0
            ? parameter.returnedOrigins
            : (parameter.returnedPaths && parameter.returnedPaths.length > 0
                ? parameter.returnedPaths
                : [[]]
              ).map((source) => ({ source, result: [] }));
        origins.forEach((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested: request.requested,
          });
          if (translated === undefined) return;
          returned = true;
          enqueueDefaultExpressions({
            resolved,
            parameterIndex: index,
            parameterRequested: translated,
          });
        });
      });
      if (!returned) unresolved = true;
    });
  }
  return !unresolved && contracts.length > 0
    ? mergeCallableBorrowContracts(contracts)
    : undefined;
};

const contractForDirectCallbackInvocation = ({
  callee,
  contract,
  args,
  ctx,
}: {
  callee: HirExprId;
  contract: CallableBorrowContract | undefined;
  args: readonly Flow[];
  ctx: SummaryContext;
}): CallableBorrowContract | undefined => {
  if (!contract) {
    return undefined;
  }
  const callbacks = callableOriginsOf(callee, ctx);
  if (callbacks.length === 0) {
    return contract;
  }
  const borrowedParameters = new Set<number>();
  callbacks.forEach(({ origin, path }) => {
    args.forEach((flow, callbackValueParameter) => {
      if (
        flow.size > 0 &&
        ctx.scopedCallbacks.has(
          `${origin}:${callbackValueParameter}:${path.join(".")}`,
        )
      ) {
        borrowedParameters.add(callbackValueParameter);
      }
    });
  });
  if (borrowedParameters.size === 0) {
    return contract;
  }
  return {
    ...contract,
    parameters: contract.parameters.map((parameter, index) => {
      if (!borrowedParameters.has(index)) {
        return parameter;
      }
      const {
        retainedUnlessBorrowed: _retainedUnlessBorrowed,
        retainedPaths: _retainedPaths,
        externalRetainedPaths: _externalRetainedPaths,
        borrowedRetainedPaths: _borrowedRetainedPaths,
        returnedPaths: _returnedPaths,
        returnedOrigins: _returnedOrigins,
        returnedSharedOrigins: _returnedSharedOrigins,
        returnedAggregate: _returnedAggregate,
        returnedTypeMatchingOrigins: _returnedConditions,
        ...base
      } = parameter;
      return { ...base, retained: false, returned: false };
    }),
    ...(contract.transfers
      ? {
          transfers: contract.transfers.filter(
            (transfer) => !borrowedParameters.has(transfer.sourceParameter),
          ),
        }
      : {}),
  };
};

const expressionProducesFreshRoot = (
  exprId: HirExprId,
  ctx: SummaryContext,
  _seen = new Set<HirExprId>(),
): boolean => {
  const type = summaryExpressionTypeFor(exprId, ctx);
  if (typeof type !== "number" || !typeIsAllocationBacked(type, ctx.typing)) {
    return false;
  }
  const leaves = factValueRequests({ facts: ctx.facts, expression: exprId });
  return (
    leaves.length > 0 &&
    leaves.every(({ expression: leaf }) => {
      const expression = summaryExpression(leaf, ctx);
      if (expression?.exprKind === "object-literal") return true;
      return (
        (expression?.exprKind === "call" ||
          expression?.exprKind === "method-call") &&
        resolvedBorrowCallFromFacts(expression, ctx).contract?.freshResult ===
          true
      );
    })
  );
};

const evaluateLambda = (
  expr: HirLambdaExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow =>
  unionFlows(
    ...expr.captures.map((capture) => {
      const type = ctx.typing.valueTypes.get(capture.symbol);
      const flow = env.get(capture.symbol) ?? emptyFlow();
      if (typeof type !== "number" || typeCanCarryReference(type, ctx.typing)) {
        return flow;
      }
      recordAccess(flow, ctx);
      return emptyFlow();
    }),
  );

const evaluatedFactFlow = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow =>
  new Map(ctx.expressionFlows.get(env)?.get(exprId) ?? emptyFlow());

/**
 * Contract-lattice transfer over an extracted callable fact graph. Recursive
 * calls model expression value flow; expression, type, place, call, and CFG
 * discovery have already been completed by `CallableBorrowFacts`.
 */
const evaluateExpressionRaw = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const expr = summaryExpression(exprId, ctx);
  if (!expr) {
    return emptyFlow();
  }
  const operations = ctx.facts.operationsForExpression.get(exprId) ?? [];
  const recordsDirectRead = operations.some(
    (operation) =>
      operation.kind === "read" &&
      operation.accessRole !== "projection-base" &&
      operation.accessRole !== "assignment-target",
  );
  const hasWrite = operations.some((operation) => operation.kind === "write");
  const hasCall = operations.some((operation) => operation.kind === "call");
  switch (expr.exprKind) {
    case "literal":
    case "overload-set":
      return emptyFlow();
    case "identifier": {
      const flow = new Map(env.get(expr.symbol) ?? emptyFlow());
      if (expressionCanCarryReference(expr.id, ctx)) {
        return flow;
      }
      if (recordsDirectRead) recordAccess(flow, ctx);
      return emptyFlow();
    }
    case "field-access": {
      const target = evaluatedFactFlow(expr.target, env, ctx);
      const projection = Number.isInteger(Number(expr.field))
        ? ({ kind: "tuple", index: Number(expr.field) } as const)
        : ({ kind: "field", name: expr.field } as const);
      const projected = projectAccessFlow(target, expr.target, projection, ctx);
      if (recordsDirectRead) recordAccess(projected, ctx);
      return expressionCanCarryReference(expr.id, ctx)
        ? projected
        : emptyFlow();
    }
    case "tuple":
      return unionFlows(
        ...expr.elements.map((element, index) => {
          const flow = evaluatedFactFlow(element, env, ctx);
          return expressionCanCarryReference(element, ctx)
            ? storeFlowAt(flow, { kind: "tuple", index })
            : emptyFlow();
        }),
      );
    case "object-literal":
      return expr.entries.reduce<MutableFlow>((result, entry) => {
        const flow = evaluatedFactFlow(entry.value, env, ctx);
        const retained = new Map(
          Array.from(result).filter(([, origin]) => {
            const provided = origin.resultProjections[0];
            if (provided?.kind !== "field") {
              return true;
            }
            if (entry.kind === "field") {
              return provided.name !== entry.name;
            }
            const spreadType = summaryExpressionTypeFor(entry.value, ctx);
            return (
              typeof spreadType !== "number" ||
              projectedTypes(spreadType, [provided], ctx.typing).length === 0
            );
          }),
        );
        if (!expressionCanCarryReference(entry.value, ctx)) {
          return retained;
        }
        const freshAllocation = expressionProducesFreshRoot(
          entry.value,
          ctx,
        )
          ? new Map<string, ParameterOrigin>([
              [
                originKey({
                  parameter: EXTERNAL_STORAGE_PARAMETER,
                  sourceEndpointAccess: "inline",
                  sourceProjections: [],
                  resultProjections: [],
                  fresh: true,
                }),
                {
                  parameter: EXTERNAL_STORAGE_PARAMETER,
                  sourceEndpointAccess: "inline",
                  sourceProjections: [],
                  resultProjections: [],
                  fresh: true,
                },
              ],
            ])
          : emptyFlow();
        const stored =
          entry.kind === "field"
            ? storeFlowAt(
                unionFlows(flow, freshAllocation),
                { kind: "field", name: entry.name },
              )
            : (() => {
                const spreadType = summaryExpressionTypeFor(entry.value, ctx);
                const resultType = summaryExpressionTypeFor(expr.id, ctx);
                if (
                  typeof spreadType !== "number" ||
                  ctx.typing.arena.get(spreadType).kind !== "borrowed" ||
                  typeof resultType !== "number"
                ) {
                  return flow;
                }
                return unionFlows(
                  ...materializedObjectReferencePaths(
                    resultType,
                    ctx.typing,
                  ).flatMap((path) => {
                    if (
                      projectedTypes(spreadType, path, ctx.typing).length === 0
                    ) {
                      return [];
                    }
                    const fieldTypes = projectedTypes(
                      resultType,
                      path,
                      ctx.typing,
                    );
                    return fieldTypes.some((type) =>
                      typeCanCarryReference(type, ctx.typing),
                    )
                      ? [
                          storeFlowAtPath(
                            fieldTypes.some((type) =>
                              typeContainsBorrowed(type, ctx.typing),
                            )
                              ? projectFlow(flow, path)
                              : new Map(
                                  Array.from(
                                    projectFlow(flow, path).values(),
                                    (origin) => {
                                      const {
                                        borrowed: _borrowed,
                                        shared: _shared,
                                        ...plain
                                      } = origin;
                                      return [originKey(plain), plain] as const;
                                    },
                                  ),
                                ),
                            path,
                          ),
                        ]
                      : [];
                  }),
                );
              })();
        return unionFlows(retained, stored);
      }, emptyFlow());
    case "lambda":
      return evaluateLambda(expr, env, ctx);
    case "block":
      return typeof expr.value === "number"
        ? evaluatedFactFlow(expr.value, env, ctx)
        : emptyFlow();
    case "if":
    case "cond":
      return unionFlows(
        ...expr.branches.map((branch) =>
          evaluatedFactFlow(branch.value, env, ctx),
        ),
        ...(typeof expr.defaultBranch === "number"
          ? [evaluatedFactFlow(expr.defaultBranch, env, ctx)]
          : []),
      );
    case "match":
      return unionFlows(
        ...expr.arms.map((arm) => evaluatedFactFlow(arm.value, env, ctx)),
      );
    case "loop":
      return evaluatedFactFlow(expr.body, env, ctx);
    case "while":
      return emptyFlow();
    case "break": {
      const flow =
        typeof expr.value === "number"
          ? evaluatedFactFlow(expr.value, env, ctx)
          : emptyFlow();
      return flow;
    }
    case "continue":
      return emptyFlow();
    case "effect-handler":
      return unionFlows(
        evaluatedFactFlow(expr.body, env, ctx),
        ...expr.handlers.map((handler) =>
          evaluatedFactFlow(handler.body, env, ctx),
        ),
      );
    case "assign": {
      const value = evaluatedFactFlow(expr.value, env, ctx);
      if (expr.pattern) {
        if (!bindFactOriginTransfer(expr.id, value, env, ctx)) {
          bindPattern(expr.pattern, value, env);
        }
        return emptyFlow();
      }
      if (typeof expr.target !== "number") {
        return emptyFlow();
      }
      if (!hasWrite) {
        return emptyFlow();
      }
      const targetExpr = summaryExpression(expr.target, ctx);
      if (targetExpr?.exprKind === "identifier") {
        const targetRecord = ctx.symbolTable.getSymbol(targetExpr.symbol);
        if (ctx.symbolTable.getScope(targetRecord.scope).kind === "module") {
          value.forEach((origin) => retainOriginExternally(origin, ctx));
          return emptyFlow();
        }
        const placeEnv = ctx.placeEnvs.get(env);
        const physicalTarget = placeEnv?.get(targetExpr.symbol) ?? emptyFlow();
        recordWrite(physicalTarget, ctx);
        const invalidated = ctx.invalidated.get(env) ?? emptyFlow();
        if (physicalTarget.size === 1) {
          physicalTarget.forEach((origin) =>
            addOrigin(invalidated, {
              ...origin,
              resultProjections: [],
            }),
          );
        }
        ctx.invalidated.set(env, invalidated);
        if (ctx.parameterOrigins.has(targetExpr.symbol)) {
          const targetParameters = new Set(
            Array.from(physicalTarget.values(), (origin) => origin.parameter),
          );
          const targetParameter = ctx.parameterOrigins.get(targetExpr.symbol);
          if (targetParameter !== undefined) {
            targetParameters.add(targetParameter);
          }
          value.forEach((origin) => {
            if (!targetParameters.has(origin.parameter)) {
              retainOrigin(origin, ctx);
            }
          });
          recordTransfersInto({
            destination: physicalTarget,
            source: value,
            ctx,
          });
        }
        if (placeEnv?.has(targetExpr.symbol)) {
          placeEnv.set(
            targetExpr.symbol,
            physicalFlowOfExpression(expr.value, env, ctx),
          );
        }
        env.set(targetExpr.symbol, new Map(value));
        return emptyFlow();
      }
      const targetPlace = placeOfExpression(expr.target, ctx);
      if (!targetPlace) {
        return emptyFlow();
      }
      const physicalTarget = physicalFlowOfExpression(expr.target, env, ctx);
      recordWrite(physicalTarget, ctx);
      const rootFlow = env.get(targetPlace.root) ?? emptyFlow();
      env.set(
        targetPlace.root,
        replaceFlowAtPath(rootFlow, value, targetPlace.projections),
      );
      const invalidated = ctx.invalidated.get(env) ?? emptyFlow();
      if (physicalTarget.size === 1) {
        physicalTarget.forEach((origin) =>
          addOrigin(invalidated, {
            ...origin,
            resultProjections: [],
          }),
        );
      }
      ctx.invalidated.set(env, invalidated);
      recordTransfersInto({
        destination: physicalTarget,
        source: value,
        ctx,
      });
      if (ctx.localOwnedRoots.has(targetPlace.root)) {
        return emptyFlow();
      }
      const targetRecord = ctx.symbolTable.getSymbol(targetPlace.root);
      const targetIsModule =
        ctx.symbolTable.getScope(targetRecord.scope).kind === "module";
      const targetParameters = new Set(
        Array.from(physicalTarget.values(), (origin) => origin.parameter),
      );
      const targetParameter = ctx.parameterOrigins.get(targetPlace.root);
      if (targetParameter !== undefined) {
        targetParameters.add(targetParameter);
      }
      value.forEach((origin) => {
        if (!targetParameters.has(origin.parameter)) {
          if (targetIsModule) {
            retainOriginExternally(origin, ctx);
            return;
          }
          retainOrigin(origin, ctx);
        }
      });
      return emptyFlow();
    }
    case "call": {
      if (!hasCall) return emptyFlow();
      const callee = evaluatedFactFlow(expr.callee, env, ctx);
      recordAccess(callee, ctx);
      const evaluated = new Map(
        expr.args.map((argument) => [
          argument.expr,
          evaluatedFactFlow(argument.expr, env, ctx),
        ]),
      );
      if (isTransparentMutableAccess(expr, ctx)) {
        const operand = expr.args.at(-1)?.expr;
        return typeof operand === "number"
          ? (evaluated.get(operand) ?? emptyFlow())
          : emptyFlow();
      }
      const resolved = resolvedBorrowCallFromFacts(expr, ctx);
      const args = resolved.arguments.map((argument) =>
        typeof argument === "number"
          ? (evaluated.get(argument) ?? emptyFlow())
          : emptyFlow(),
      );
      if (
        resolved.targets.some((target) =>
          targetMaySuspend(target, resolved, ctx),
        ) ||
        (resolved.targets.length === 0 &&
          targetMaySuspend(undefined, resolved, ctx, expr.callee))
      ) {
        ctx.maySuspend.value = true;
      }
      const result = applyCallContract({
        contract: contractForDirectCallbackInvocation({
          callee: expr.callee,
          contract: resolved.contract,
          args,
          ctx,
        }),
        args,
        argExprs: resolved.arguments,
        callExprId: expr.id,
        env,
        ctx,
      });
      return expressionCanCarryReference(expr.id, ctx) ? result : emptyFlow();
    }
    case "method-call": {
      if (!hasCall) return emptyFlow();
      const evaluated = new Map<HirExprId, MutableFlow>([
        [expr.target, evaluatedFactFlow(expr.target, env, ctx)],
        ...expr.args.map(
          (argument) =>
            [
              argument.expr,
              evaluatedFactFlow(argument.expr, env, ctx),
            ] as const,
        ),
      ]);
      const resolved = resolvedBorrowCallFromFacts(expr, ctx);
      const args = resolved.arguments.map((argument) =>
        typeof argument === "number"
          ? (evaluated.get(argument) ?? emptyFlow())
          : emptyFlow(),
      );
      if (
        resolved.targets.length > 0
          ? resolved.targets.some((target) =>
              targetMaySuspend(target, resolved, ctx),
            )
          : targetMaySuspend(undefined, resolved, ctx)
      ) {
        ctx.maySuspend.value = true;
      }
      const result = applyCallContract({
        contract: resolved.contract,
        args,
        argExprs: resolved.arguments,
        callExprId: expr.id,
        env,
        ctx,
      });
      return expressionCanCarryReference(expr.id, ctx) ? result : emptyFlow();
    }
  }
};

const bindFactOriginTransfer = (
  exprId: HirExprId,
  flow: Flow,
  env: MutableEnv,
  ctx: SummaryContext,
): boolean => {
  const targets = (ctx.facts.operationsForExpression.get(exprId) ?? []).flatMap(
    (operation) =>
      operation.kind === "origin-transfer"
        ? operation.targets.filter((target) => target.destination !== true)
        : [],
  );
  targets.forEach((target) =>
    env.set(target.symbol, projectFlow(flow, target.projections)),
  );
  return targets.length > 0;
};

const evaluateExpression = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const flow = evaluateExpressionRaw(exprId, env, ctx);
  const typeId = summaryExpressionTypeFor(exprId, ctx);
  const resultNominal = nominalResultType(typeId, ctx.typing);
  const sourceEndpointAccess: ParameterOrigin["sourceEndpointAccess"] =
    typeof typeId === "number" &&
    ctx.typing.arena.get(typeId).kind === "fixed-array"
      ? "dereferenced"
      : "inline";
  return new Map(
    Array.from(flow.values(), (origin) => {
      const withResultType =
        typeof resultNominal === "number"
          ? { ...origin, resultNominal }
          : origin;
      const normalized =
        origin.resultProjections.length === 0
          ? { ...withResultType, sourceEndpointAccess }
          : withResultType;
      return [originKey(normalized), normalized];
    }),
  );
};

/** Runs contract transfer over the authoritative callable fact CFG. */
const evaluateFactRoot = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const root = ctx.facts.roots.find(
    (candidate) => candidate.expression === exprId,
  );
  if (!root) {
    throw new Error(`missing borrow fact root for expression ${exprId}`);
  }
  const evaluateBlock = (
    block: CallableBorrowFacts["blocks"][number],
    state: MutableEnv,
  ): void => {
    block.expressions.forEach((expression) => {
      (ctx.facts.matchBindingsBeforeExpression.get(expression) ?? []).forEach(
        (binding) =>
          bindPattern(
            binding.pattern,
            evaluatedFactFlow(binding.value, state, ctx),
            state,
          ),
      );
      const flow = evaluateExpression(expression, state, ctx);
      const values = ctx.expressionFlows.get(state)!;
      if (flow.size > 0) values.set(expression, flow);
      else values.delete(expression);

      (ctx.facts.bindingsAfterExpression.get(expression) ?? []).forEach(
        ({ statementId }) => {
          const statement = ctx.facts.statements.get(statementId);
          if (statement?.kind !== "let") return;
          const locallyOwnedSymbols =
            statement.pattern.kind === "identifier" &&
            physicalFlowOfExpression(statement.initializer, state, ctx).size ===
              0
              ? new Set([statement.pattern.symbol])
              : new Set<SymbolId>();
          if (!bindFactOriginTransfer(expression, flow, state, ctx)) {
            bindPattern(statement.pattern, flow, state);
          }
          mutablePatternSymbols(statement.pattern).forEach((symbol) =>
            ctx.placeEnvs
              .get(state)
              ?.set(
                symbol,
                locallyOwnedSymbols.has(symbol)
                  ? emptyFlow()
                  : new Map(state.get(symbol) ?? emptyFlow()),
              ),
          );
          patternSymbols(statement.pattern).forEach((symbol) =>
            ctx.bindingInitializers.set(symbol, statement.initializer),
          );
          locallyOwnedSymbols.forEach((symbol) =>
            ctx.localOwnedRoots.add(symbol),
          );
        },
      );
      const hasBinding =
        (ctx.facts.bindingsAfterExpression.get(expression)?.length ?? 0) > 0;
      const operations = ctx.facts.operationsForExpression.get(expression) ?? [];
      if (!hasBinding) {
        operations.forEach((operation) => {
          if (operation.kind === "define") state.delete(operation.symbol);
        });
      }
    });
  };
  const recordReturns = (
    block: CallableBorrowFacts["blocks"][number],
    state: MutableEnv,
  ): void => {
    block.operations.forEach((operation) => {
      if (operation.kind !== "return" || operation.value === undefined) return;
      const rawFlow = unionFlows(
        evaluatedFactFlow(operation.value, state, ctx),
        explicitBorrowedResultFlow(
          operation.value,
          ctx.borrowedReturnPaths,
          state,
          ctx,
        ),
      );
      const flow = flowMarkedForBorrowedReturn(
        flowProjectedThroughReturnedTrait(rawFlow, ctx.borrowedReturnType, ctx),
        ctx.borrowedReturnType,
        ctx.typing,
      );
      ctx.freshReturns.push(expressionProducesFreshRoot(operation.value, ctx));
      ctx.returnSnapshots.push({
        flow: new Map(flow),
        invalidated: new Map(ctx.invalidated.get(state) ?? emptyFlow()),
      });
      flow.forEach((origin) => addOrigin(ctx.returned, origin));
    });
  };
  if (root.blocks.length === 1) {
    incrementCompilerPerfCounter("borrowing.summary.linearFactRoots");
    const block = ctx.facts.blocks[root.blocks[0]!];
    if (!block) return emptyFlow();
    evaluateBlock(block, env);
    recordReturns(block, env);
    return evaluatedFactFlow(exprId, env, ctx);
  }
  const allowed = new Set(root.blocks);
  const incoming = new Map<number, MutableEnv>();
  const outgoing = new Map<number, MutableEnv>();
  const initial = cloneEnv(env, ctx);
  const liveSymbols = new Map<number, Set<SymbolId>>();
  ctx.facts.liveness.forEach((liveness, symbol) =>
    liveness.liveInBlocks.forEach((block) => {
      const symbols = liveSymbols.get(block) ?? new Set<SymbolId>();
      symbols.add(symbol);
      liveSymbols.set(block, symbols);
    }),
  );
  const pruneState = (state: MutableEnv, block: number): void => {
    const symbols = liveSymbols.get(block) ?? new Set();
    Array.from(state.keys()).forEach((symbol) => {
      if (!symbols.has(symbol)) state.delete(symbol);
    });
    const places = ctx.placeEnvs.get(state);
    Array.from(places?.keys() ?? []).forEach((symbol) => {
      if (!symbols.has(symbol)) places?.delete(symbol);
    });
    const values = ctx.expressionFlows.get(state);
    Array.from(values?.keys() ?? []).forEach((expression) => {
      if (
        !ctx.facts.expressionValueLiveness
          .get(expression)
          ?.liveInBlocks.includes(block)
      ) {
        values?.delete(expression);
      }
    });
  };
  pruneState(initial, root.entryBlock);
  incoming.set(root.entryBlock, initial);
  const ownedIncoming = new Set([root.entryBlock]);
  const pending = [root.entryBlock];
  let pendingCursor = 0;
  const loopHeaders = new Set(ctx.facts.loopHeaderForExpression.values());
  const stateKeys = new WeakMap<MutableEnv, string>();
  const stateKey = (state: MutableEnv): string => {
    const cached = stateKeys.get(state);
    if (cached !== undefined) return cached;
    const key = environmentStateKey(state, ctx);
    stateKeys.set(state, key);
    return key;
  };

  while (pendingCursor < pending.length) {
    const blockId = pending[pendingCursor++]!;
    const entry = incoming.get(blockId);
    const block = ctx.facts.blocks[blockId];
    if (!entry || !block || !allowed.has(blockId)) continue;
    const state = ownedIncoming.delete(blockId) ? entry : cloneEnv(entry, ctx);
    pruneState(state, blockId);
    evaluateBlock(block, state);
    outgoing.set(blockId, state);

    const successors = block.successors.filter((successor) =>
      allowed.has(successor),
    );
    successors.forEach((successor) => {
      const prior = incoming.get(successor);
      if (prior === undefined && !loopHeaders.has(successor)) {
        incoming.set(successor, state);
        const successorBlock = ctx.facts.blocks[successor];
        const uniquelyTransferred =
          successors.length === 1 &&
          successorBlock?.predecessors.filter((predecessor) =>
            allowed.has(predecessor),
          ).length === 1 &&
          !block.operations.some((operation) => operation.kind === "return");
        if (uniquelyTransferred) ownedIncoming.add(successor);
        pending.push(successor);
        return;
      }
      const next = prior ? cloneEnv(prior, ctx) : cloneEnv(state, ctx);
      if (prior) mergeEnvs(next, [prior, state], ctx);
      pruneState(next, successor);
      if (loopHeaders.has(successor)) {
        widenLoopEnvironment(next, ctx);
      }
      const changed = prior === undefined || stateKey(next) !== stateKey(prior);
      if (changed) {
        incoming.set(successor, next);
        pending.push(successor);
      }
    });
  }

  outgoing.forEach((state, blockId) =>
    recordReturns(ctx.facts.blocks[blockId]!, state),
  );

  const rootBlock = ctx.facts.blockForExpression.get(exprId);
  const completed =
    rootBlock === undefined ? undefined : outgoing.get(rootBlock);
  if (!completed) return emptyFlow();
  mergeEnvs(env, [completed], ctx);
  return evaluatedFactFlow(exprId, completed, ctx);
};

const parameterContract = (
  functionItem: HirFunction,
  index: number,
  typing: TypingResult,
): CallableParameterBorrowContract => {
  const access =
    functionItem.parameters[index]?.pattern.bindingKind === "mutable-ref"
      ? "mutable"
      : (() => {
          const type = typing.functions.getSignature(functionItem.symbol)
            ?.parameters[index]?.type;
          if (typeof type !== "number") {
            return "shared";
          }
          return typeCanCarryReference(type, typing) ? "shared" : "owned";
        })();
  return {
    access,
    readPaths: [],
    writePaths: [],
    retained: false,
    returned: false,
  };
};

const initialFunctionContract = ({
  functionItem,
  typing,
  symbolTable,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): CallableBorrowContract => {
  const scopedCallbacks = declaredScopedCallbacks({
    functionItem,
    typing,
  });
  return {
    parameters: functionItem.parameters.map((_parameter, index) => ({
      ...parameterContract(functionItem, index, typing),
      ...(index === 0 &&
      hasRuntimeCheckedReceiverWrites({ functionItem, typing, symbolTable })
        ? { runtimeCheckedWrites: true as const }
        : {}),
    })),
    maySuspend: false,
    borrowedResult: "none",
    ...(scopedCallbacks.length > 0 ? { scopedCallbacks } : {}),
  };
};

const initialLambdaContract = (
  lambda: HirLambdaExpr,
  typing: TypingResult,
): CallableBorrowContract => {
  const lambdaType = typing.resolvedExprTypes.get(lambda.id);
  const signature =
    typeof lambdaType === "number" ? typing.arena.get(lambdaType) : undefined;
  return {
    parameters: lambda.parameters.map((parameter, index) => {
      const type =
        signature?.kind === "function"
          ? signature.parameters[index]?.type
          : undefined;
      return {
        access:
          parameter.pattern.bindingKind === "mutable-ref"
            ? "mutable"
            : typeof type === "number" && !typeCanCarryReference(type, typing)
              ? "owned"
              : "shared",
        readPaths: [],
        writePaths: [],
        retained: false,
        returned: false,
      };
    }),
    maySuspend: false,
    borrowedResult: "none",
  };
};

const declaredScopedCallbacks = ({
  functionItem,
  typing,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
}): readonly ScopedCallbackBorrowContract[] => {
  const signature = typing.functions.getSignature(functionItem.symbol);
  return (
    signature?.parameters.flatMap((parameter, callbackParameter) => {
      const callback = typing.arena.get(parameter.type);
      if (callback.kind !== "function") {
        return [];
      }
      return callback.parameters.flatMap(
        (valueParameter, callbackValueParameter) =>
          typing.arena.get(valueParameter.type).kind === "borrowed"
            ? [
                {
                  callbackParameter,
                  callbackValueParameter,
                  access:
                    valueParameter.bindingKind === "mutable-ref"
                      ? ("mutable" as const)
                      : ("shared" as const),
                },
              ]
            : [],
      );
    }) ?? []
  );
};

const hasRuntimeCheckedReceiverWrites = ({
  functionItem,
  typing,
  symbolTable,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): boolean => {
  const owner = typing.memberMetadata.get(functionItem.symbol)?.owner;
  if (typeof owner !== "number") {
    return false;
  }
  const metadata = symbolTable.getSymbol(owner).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  return metadata?.intrinsicType === STD_INTRINSIC_TYPE.sharedCell;
};

const allOriginsForParameter = (
  flow: Flow,
  parameter: number,
): readonly ParameterOrigin[] =>
  Array.from(flow.values()).filter((origin) => origin.parameter === parameter);

const originsForParameter = (
  flow: Flow,
  parameter: number,
): readonly ParameterOrigin[] =>
  allOriginsForParameter(flow, parameter).filter(
    (origin) => origin.defaultParameter === undefined,
  );

const escapingRetainedOrigins = ({
  retained,
  returned,
  transfers,
}: {
  retained: Flow;
  returned: Flow;
  transfers: Iterable<CallableBorrowTransfer>;
}): MutableFlow => {
  const returnedOrigins = Array.from(returned.values());
  const recordedTransfers = Array.from(transfers);
  return new Map(
    Array.from(retained).filter(([_key, origin]) => {
      const returnedFromFunction = returnedOrigins.some(
        (candidate) =>
          candidate.parameter === origin.parameter &&
          JSON.stringify(candidate.sourceProjections) ===
            JSON.stringify(origin.sourceProjections),
      );
      if (returnedFromFunction) {
        return false;
      }
      const rehomedWithinParameter = recordedTransfers.some(
        (transfer) =>
          transfer.sourceInvalidated === true &&
          transfer.sourceParameter === origin.parameter &&
          transfer.destinationParameter === origin.parameter &&
          JSON.stringify(transfer.sourcePath ?? []) ===
            JSON.stringify(origin.sourceProjections),
      );
      return !rehomedWithinParameter;
    }),
  );
};

const pathsForParameter = (
  flow: Flow,
  parameter: number,
): readonly (readonly PlaceProjection[])[] => {
  const paths = Array.from(
    new Map(
      originsForParameter(flow, parameter).map((origin) => [
        projectionPathKey(origin.sourceProjections),
        origin.sourceProjections,
      ]),
    ).values(),
  );
  return paths;
};

const returnedContractOriginsForParameter = (
  returned: Flow,
  parameter: number,
): {
  origins: readonly ReturnedBorrowOrigin[];
  typeMatching: readonly ReturnedTypeMatchingOrigin[];
} => {
  const groups = new Map<string, ParameterOrigin[]>();
  originsForParameter(returned, parameter).forEach((origin) => {
    const key = JSON.stringify([
      origin.sourceProjections,
      origin.resultProjections,
      origin.sourceEndpointAccess,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), origin]);
  });
  const entries = Array.from(groups.values()).map((group) => {
    return {
      origin: {
        source: group[0]!.sourceProjections,
        result: group[0]!.resultProjections,
        endpointAccess: group[0]!.sourceEndpointAccess,
      },
      conditionId: group.every(
        (origin) => origin.returnTypeConditionId !== undefined,
      )
        ? borrowTypeConditionId({
            parameter,
            sourcePath: group[0]!.sourceProjections,
            resultPath: group[0]!.resultProjections,
            endpointAccess: group[0]!.sourceEndpointAccess,
          })
        : undefined,
    };
  });
  return {
    origins: entries.map((entry) => entry.origin),
    typeMatching: entries
      .filter(
        (entry): entry is typeof entry & { conditionId: string } =>
          entry.conditionId !== undefined,
      )
      .map((entry) => ({
        ...entry.origin,
        conditionId: entry.conditionId,
      })),
  };
};

const externalReturnedOrigins = (
  returned: Flow,
): NonNullable<CallableBorrowContract["externalReturnedOrigins"]> =>
  Array.from(
    new Map(
      originsForParameter(returned, EXTERNAL_STORAGE_PARAMETER)
        .filter((origin) => origin.defaultParameter === undefined)
        .map((origin) => {
          const external = {
            result: origin.resultProjections,
            endpointAccess: origin.sourceEndpointAccess,
            ...(origin.fresh ? { fresh: true as const } : {}),
          };
          return [JSON.stringify(external), external] as const;
        }),
    ).values(),
  );

const flowHasUnconditionalExternalOrigin = (flow: Flow): boolean =>
  originsForParameter(flow, EXTERNAL_STORAGE_PARAMETER).some(
    (origin) => origin.defaultParameter === undefined && origin.fresh !== true,
  );

const accessConditionForParameter = (
  accessed: Flow,
  returned: Flow,
  parameter: number,
): BorrowTypeComparison | undefined => {
  const origins = originsForParameter(accessed, parameter);
  if (
    origins.length === 0 ||
    origins.some((origin) => origin.accessTypeComparator === undefined)
  ) {
    return undefined;
  }
  const comparators = new Map(
    origins.map((origin) => [
      JSON.stringify(origin.accessTypeComparator),
      origin.accessTypeComparator!,
    ]),
  );
  if (comparators.size !== 1) {
    return undefined;
  }
  const comparator = Array.from(comparators.values())[0]!;
  const matchingReturns = originsForParameter(
    returned,
    comparator.parameter,
  ).filter(
    (origin) =>
      origin.returnTypeConditionId === comparator.conditionId &&
      JSON.stringify(origin.sourceProjections) ===
        JSON.stringify(comparator.sourceProjections),
  );
  const resultPaths = new Map(
    matchingReturns.map((origin) => [
      JSON.stringify([origin.resultProjections, origin.sourceEndpointAccess]),
      {
        resultPath: origin.resultProjections,
        endpointAccess: origin.sourceEndpointAccess,
      },
    ]),
  );
  if (resultPaths.size !== 1) {
    return undefined;
  }
  const result = Array.from(resultPaths.values())[0]!;
  return {
    conditionId: borrowTypeConditionId({
      parameter: comparator.parameter,
      sourcePath: comparator.sourceProjections,
      resultPath: result.resultPath,
      endpointAccess: result.endpointAccess,
    }),
    parameter: comparator.parameter,
    sourcePath: comparator.sourceProjections,
    resultPath: result.resultPath,
    endpointAccess: result.endpointAccess,
  };
};

const mergePaths = (
  ...groups: readonly (readonly (readonly PlaceProjection[])[])[]
): readonly (readonly PlaceProjection[])[] =>
  Array.from(
    new Map(
      groups.flat().map((path) => [JSON.stringify(path), path] as const),
    ).values(),
  );

const minimizeProjectionPaths = (
  paths: readonly (readonly PlaceProjection[])[],
): readonly (readonly PlaceProjection[])[] =>
  paths.filter(
    (path, index) =>
      !paths.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && projectionPathCovers(candidate, path),
      ),
  );

const returnedSharedOriginsForParameter = ({
  returned,
  returnSnapshots,
  parameter,
}: {
  returned: Flow;
  returnSnapshots: readonly ReturnSnapshot[];
  parameter: number;
}): readonly ParameterOrigin[] => {
  const sharedOriginKey = (origin: ParameterOrigin): string =>
    [
      projectionPathKey(origin.sourceProjections),
      projectionPathKey(origin.resultProjections),
      origin.sourceEndpointAccess,
    ].join("|");
  const origins = Array.from(
    new Map(
      originsForParameter(returned, parameter).map((origin) => [
        sharedOriginKey(origin),
        origin,
      ]),
    ).values(),
  );
  const snapshotOriginsByKey = returnSnapshots.map((snapshot) => {
    const byKey = new Map<string, ParameterOrigin[]>();
    originsForParameter(snapshot.flow, parameter).forEach((origin) => {
      const key = sharedOriginKey(origin);
      byKey.set(key, [...(byKey.get(key) ?? []), origin]);
    });
    return { snapshot, byKey };
  });
  return origins.filter((origin) =>
    snapshotOriginsByKey.every(({ snapshot, byKey }) => {
      const matching = byKey.get(sharedOriginKey(origin)) ?? [];
      return (
        matching.length === 0 ||
        originWasInvalidated(origin, snapshot.invalidated) ||
        matching.every((candidate) => candidate.shared === true)
      );
    }),
  );
};

const summarizeFunction = ({
  functionItem,
  facts,
  lambdaFacts,
  baseContracts,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
}: {
  functionItem: HirFunction;
  facts: CallableBorrowFacts;
  lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts>;
  baseContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
}): CallableBorrowContract => {
  incrementCompilerPerfCounter("borrowing.summary.evaluations");
  const runtimeCheckedReceiverWrites = hasRuntimeCheckedReceiverWrites({
    functionItem,
    typing,
    symbolTable,
  });
  const accessed = emptyFlow();
  const written = emptyFlow();
  const uncheckedWritten = emptyFlow();
  const retained = emptyFlow();
  const externalRetained = emptyFlow();
  const borrowedRetained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map(
    declaredScopedCallbacks({
      functionItem,
      typing,
    }).map((callback) => [
      `${callback.callbackParameter}:${callback.callbackValueParameter}:`,
      callback,
    ]),
  );
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const placeEnvs = new Map<MutableEnv, Map<SymbolId, MutableFlow>>();
  const expressionFlows = new Map<MutableEnv, Map<HirExprId, MutableFlow>>();
  const localOwnedRoots = new Set<SymbolId>();
  const invalidated = new Map<MutableEnv, MutableFlow>();
  const returnSnapshots: ReturnSnapshot[] = [];
  const freshReturns: boolean[] = [];
  const transfers = new Map<string, CallableBorrowTransfer>();
  const defaultOrigins = new Map<number, readonly DefaultBorrowOrigin[]>();
  const defaultReadOrigins = new Map<
    number,
    readonly DefaultBorrowAccessOrigin[]
  >();
  const defaultWriteOrigins = new Map<
    number,
    readonly DefaultBorrowAccessOrigin[]
  >();
  const defaultExternalOrigins = new Map<
    number,
    NonNullable<CallableParameterBorrowContract["defaultExternalOrigins"]>
  >();
  const defaultExternalReads = new Set<number>();
  const defaultExternalWrites = new Set<number>();
  const defaultBorrowedResults = new Map<number, "none">();
  const defaultNoBorrowPaths = new Map<
    number,
    readonly (readonly PlaceProjection[])[]
  >();
  const parameterFlows = new Map(
    functionItem.parameters.map((parameter, index) => [
      index,
      flowWithExplicitBorrowedOrigins({
        flow: parameterFlowForPattern({
          parameter: index,
          pattern: parameter.pattern,
          typing,
        }),
        parameter: index,
        type: facts.declaredConstraints.parameterTypes[index],
        typing,
      }),
    ]),
  );
  const functionReturnType = facts.declaredConstraints.returnType;
  const parameterSymbolFlows = new Map<SymbolId, Flow>();
  const env: MutableEnv = new Map();
  invalidated.set(env, emptyFlow());
  placeEnvs.set(env, new Map());
  expressionFlows.set(env, new Map());
  externalModuleBindingFlows(hir, typing, imports, dependencies).forEach(
    (flow, symbol) => env.set(symbol, new Map(flow)),
  );
  functionItem.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlows.get(index)!, env);
    patternSymbols(parameter.pattern).forEach((symbol) => {
      parameterOrigins.set(symbol, index);
      parameterSymbolFlows.set(symbol, new Map(env.get(symbol) ?? emptyFlow()));
    });
    mutablePatternSymbols(parameter.pattern).forEach((symbol) =>
      placeEnvs.get(env)!.set(symbol, new Map(env.get(symbol) ?? emptyFlow())),
    );
  });
  const ctx: SummaryContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    contracts: baseContracts,
    borrowIndexMode: "symbolic",
    accessed,
    written,
    uncheckedWritten,
    retained,
    externalRetained,
    borrowedRetained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    callResolutionCache: new Map(),
    parameterOrigins,
    parameterSymbolFlows,
    placeEnvs,
    expressionFlows,
    localOwnedRoots,
    invalidated,
    returnSnapshots,
    freshReturns,
    borrowedReturnType: functionReturnType,
    borrowedReturnPaths:
      typeof functionReturnType === "number"
        ? borrowedPathsInType(functionReturnType, typing)
        : [],
    transfers,
    decls,
    facts,
    lambdaFacts,
  };
  functionItem.parameters.forEach((parameter, index) => {
    if (typeof parameter.defaultValue !== "number") {
      return;
    }
    const defaultAccessed = emptyFlow();
    const defaultWritten = emptyFlow();
    const evaluatedDefaultFlow = evaluateFactRoot(parameter.defaultValue, env, {
      ...ctx,
      accessed: defaultAccessed,
      written: defaultWritten,
    });
    const parameterType = facts.declaredConstraints.parameterTypes[index];
    if (
      borrowedResultPresenceFromFlow({
        flow: evaluatedDefaultFlow,
        type: parameterType,
        typing,
      }) === "none"
    ) {
      defaultBorrowedResults.set(index, "none");
    }
    if (typeof parameterType === "number") {
      const candidatePaths = [
        [],
        ...[
          ...borrowedPathsInType(parameterType, typing),
          ...typeParameterPathsInType(parameterType, typing),
        ].flatMap((path) =>
          path.map((_projection, pathIndex) => path.slice(0, pathIndex + 1)),
        ),
      ];
      const noBorrowPaths = Array.from(
        new Map(
          candidatePaths
            .filter(
              (path) =>
                borrowedResultPresenceFromFlow({
                  flow: evaluatedDefaultFlow,
                  type: parameterType,
                  typing,
                  path,
                }) === "none",
            )
            .map((path) => [JSON.stringify(path), path]),
        ).values(),
      );
      if (noBorrowPaths.length > 0) {
        defaultNoBorrowPaths.set(index, noBorrowPaths);
      }
    }
    const defaultFlow = new Map(
      Array.from(evaluatedDefaultFlow.values(), (origin) => {
        const tagged =
          origin.defaultParameter === undefined
            ? { ...origin, defaultParameter: index }
            : origin;
        return [originKey(tagged), tagged] as const;
      }),
    );
    defaultExternalOrigins.set(
      index,
      Array.from(
        new Map(
          Array.from(evaluatedDefaultFlow.values())
            .filter(
              (origin) =>
                origin.parameter === EXTERNAL_STORAGE_PARAMETER &&
                origin.defaultParameter === undefined,
            )
            .map((origin) => {
              const external = {
                result: origin.resultProjections,
                endpointAccess: origin.sourceEndpointAccess,
                ...(origin.fresh ? { fresh: true as const } : {}),
              };
              return [JSON.stringify(external), external] as const;
            }),
        ).values(),
      ),
    );
    const serializeAccessOrigins = (
      flow: Flow,
    ): readonly DefaultBorrowAccessOrigin[] =>
      Array.from(
        new Map(
          Array.from(flow.values())
            .filter(
              (origin) =>
                origin.parameter !== EXTERNAL_STORAGE_PARAMETER &&
                origin.defaultParameter === undefined,
            )
            .map((origin) => {
              const serialized = {
                parameter: origin.parameter,
                path: origin.sourceProjections,
              };
              return [JSON.stringify(serialized), serialized] as const;
            }),
        ).values(),
      );
    Array.from(defaultAccessed.values())
      .filter(
        (origin) =>
          origin.parameter === EXTERNAL_STORAGE_PARAMETER &&
          origin.defaultParameter === undefined &&
          origin.fresh !== true,
      )
      .forEach(() => defaultExternalReads.add(index));
    Array.from(defaultWritten.values())
      .filter(
        (origin) =>
          origin.parameter === EXTERNAL_STORAGE_PARAMETER &&
          origin.defaultParameter === undefined &&
          origin.fresh !== true,
      )
      .forEach(() => defaultExternalWrites.add(index));
    defaultReadOrigins.set(index, serializeAccessOrigins(defaultAccessed));
    defaultWriteOrigins.set(index, serializeAccessOrigins(defaultWritten));
    defaultOrigins.set(
      index,
      Array.from(
        new Map(
          Array.from(evaluatedDefaultFlow.values())
            .filter(
              (origin) =>
                origin.parameter !== EXTERNAL_STORAGE_PARAMETER &&
                origin.defaultParameter === undefined,
            )
            .map((origin) => {
              const serialized: DefaultBorrowOrigin = {
                parameter: origin.parameter,
                source: origin.sourceProjections,
                result: origin.resultProjections,
                endpointAccess: origin.sourceEndpointAccess,
              };
              return [JSON.stringify(serialized), serialized] as const;
            }),
        ).values(),
      ),
    );
    const suppliedFlow = unionFlows(
      parameterFlows.get(index) ?? emptyFlow(),
      defaultFlow,
    );
    bindPattern(parameter.pattern, suppliedFlow, env);
  });
  evaluateFactRoot(functionItem.body, env, ctx);
  const definitelyInvalidated = intersectFlows(
    returnSnapshots.map((snapshot) => snapshot.invalidated),
  );
  const escapingRetained = escapingRetainedOrigins({
    retained,
    returned,
    transfers: transfers.values(),
  });
  const returnedExternalOrigins = externalReturnedOrigins(returned);
  const defaultCallableContractForParameter = (
    index: number,
    requested: readonly PlaceProjection[],
    seen = new Set<number>(),
  ): CallableBorrowContract | undefined => {
    if (seen.has(index)) {
      return undefined;
    }
    seen.add(index);
    const defaultValue = functionItem.parameters[index]?.defaultValue;
    if (typeof defaultValue !== "number") {
      return undefined;
    }
    return callableContractOfExpression({
      exprId: defaultValue,
      ctx,
      requested,
      resolveParameterDefault: (symbol, parameterRequested) => {
        const parameterIndex = parameterOrigins.get(symbol);
        return typeof parameterIndex === "number"
          ? defaultCallableContractForParameter(
              parameterIndex,
              parameterRequested,
              new Set(seen),
            )
          : undefined;
      },
    });
  };
  const scopedCallbackContracts = Array.from(
    scopedCallbacks.values(),
    (callback): ScopedCallbackBorrowContract => {
      if (
        typeof functionItem.parameters[callback.callbackParameter]
          ?.defaultValue !== "number"
      ) {
        return callback;
      }
      const defaultContract = defaultCallableContractForParameter(
        callback.callbackParameter,
        callback.callbackPath?.map((part) =>
          Number.isInteger(Number(part))
            ? ({ kind: "tuple", index: Number(part) } as const)
            : ({ kind: "field", name: part } as const),
        ) ?? [],
      );
      const defaultValueParameter =
        defaultContract?.parameters[callback.callbackValueParameter];
      const defaultCallbackBehavior =
        defaultContract === undefined || defaultValueParameter === undefined
          ? ("unknown" as const)
          : defaultValueParameter.retained ||
              defaultValueParameter.returned ||
              defaultValueParameter.borrowedRetainedPaths !== undefined
            ? ("escapes" as const)
            : ("safe" as const);
      return { ...callback, defaultCallbackBehavior };
    },
  );
  const contract: CallableBorrowContract = {
    parameters: functionItem.parameters.map((_parameter, index) => {
      const directlyRetainedPaths = pathsForParameter(escapingRetained, index);
      const externalRetainedPaths = pathsForParameter(externalRetained, index);
      const retainedPaths = mergePaths(
        directlyRetainedPaths,
        externalRetainedPaths,
      );
      const retainedOrigins = originsForParameter(escapingRetained, index);
      const externalRetainedOrigins = originsForParameter(
        externalRetained,
        index,
      );
      const retainedUnlessBorrowed =
        retainedPaths.length > 0 &&
        [...retainedOrigins, ...externalRetainedOrigins].every(
          (origin) => origin.retainedUnlessBorrowed === true,
        );
      const borrowedRetainedPaths = pathsForParameter(borrowedRetained, index);
      const returnedContractOrigins = returnedContractOriginsForParameter(
        returned,
        index,
      );
      const returnedOrigins = returnedContractOrigins.origins;
      const invalidatedPaths = pathsForParameter(definitelyInvalidated, index);
      const returnedSharedOrigins = returnedSharedOriginsForParameter({
        returned,
        returnSnapshots,
        parameter: index,
      }).map((origin) => ({
        source: origin.sourceProjections,
        result: origin.resultProjections,
        endpointAccess: origin.sourceEndpointAccess,
      }));
      const completeReturnedOrigins = Array.from(
        new Map(
          [...returnedOrigins, ...returnedSharedOrigins].map((origin) => [
            JSON.stringify(origin),
            origin,
          ]),
        ).values(),
      );
      const returnedAggregate =
        typeof functionReturnType === "number" &&
        borrowedPathsInType(functionReturnType, typing).some(
          (path) => path.length > 0,
        ) &&
        completeReturnedOrigins.some(
          (origin) => origin.source.length === 0 && origin.result.length === 0,
        );
      const access =
        baseContracts.get(functionItem.symbol)?.parameters[index]?.access ??
        parameterContract(functionItem, index, typing).access;
      const readPaths = minimizeProjectionPaths(
        pathsForParameter(accessed, index),
      );
      const writePaths = minimizeProjectionPaths(
        pathsForParameter(written, index),
      );
      const hasUncheckedWrites =
        pathsForParameter(uncheckedWritten, index).length > 0;
      const accessCondition = accessConditionForParameter(
        accessed,
        returned,
        index,
      );
      const returnedTypeMatchingOrigins = returnedContractOrigins.typeMatching;
      const defaultExternalRead = defaultExternalReads.has(index);
      const defaultExternalWrite = defaultExternalWrites.has(index);
      return {
        access,
        ...(readPaths.length > 0 ? { readPaths } : {}),
        ...(writePaths.length > 0 ? { writePaths } : {}),
        ...(writePaths.length > 0 &&
        ((index === 0 && runtimeCheckedReceiverWrites) || !hasUncheckedWrites)
          ? { runtimeCheckedWrites: true as const }
          : {}),
        ...(accessCondition
          ? { accessIfResultTypeDiffers: accessCondition }
          : {}),
        retained: retainedPaths.length > 0,
        ...(retainedUnlessBorrowed
          ? { retainedUnlessBorrowed: true as const }
          : {}),
        returned: completeReturnedOrigins.length > 0,
        ...(returnedTypeMatchingOrigins.length > 0
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(externalRetainedPaths.length > 0 ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths.length > 0 ? { borrowedRetainedPaths } : {}),
        ...(completeReturnedOrigins.length > 0
          ? { returnedOrigins: completeReturnedOrigins }
          : {}),
        ...(returnedAggregate ? { returnedAggregate: true as const } : {}),
        ...(returnedSharedOrigins.length > 0 ? { returnedSharedOrigins } : {}),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
        ...(defaultOrigins.get(index)?.length
          ? { defaultOrigins: defaultOrigins.get(index) }
          : {}),
        ...(defaultReadOrigins.get(index)?.length
          ? { defaultReadOrigins: defaultReadOrigins.get(index) }
          : {}),
        ...(defaultWriteOrigins.get(index)?.length
          ? { defaultWriteOrigins: defaultWriteOrigins.get(index) }
          : {}),
        ...(defaultExternalOrigins.get(index)?.length
          ? { defaultExternalOrigins: defaultExternalOrigins.get(index) }
          : {}),
        ...(defaultExternalRead ? { defaultExternalRead: true as const } : {}),
        ...(defaultExternalWrite
          ? { defaultExternalWrite: true as const }
          : {}),
        ...(defaultBorrowedResults.get(index) === "none"
          ? { defaultBorrowedResult: "none" as const }
          : {}),
        ...((defaultNoBorrowPaths.get(index)?.length ?? 0) > 0
          ? { defaultNoBorrowPaths: defaultNoBorrowPaths.get(index) }
          : {}),
      };
    }),
    maySuspend: maySuspend.value,
    borrowedResult: borrowedResultPresenceFromFlow({
      flow: returned,
      type: functionReturnType,
      typing,
    }),
    ...(freshReturns.length > 0 && freshReturns.every(Boolean)
      ? { freshResult: true as const }
      : {}),
    ...(flowHasUnconditionalExternalOrigin(accessed)
      ? { externalRead: true as const }
      : {}),
    ...(flowHasUnconditionalExternalOrigin(written)
      ? { externalWrite: true as const }
      : {}),
    ...(returnedExternalOrigins.length > 0
      ? { externalReturnedOrigins: returnedExternalOrigins }
      : {}),
    ...(transfers.size > 0
      ? { transfers: Array.from(transfers.values()) }
      : {}),
    ...(scopedCallbackContracts.length > 0
      ? { scopedCallbacks: scopedCallbackContracts }
      : {}),
  };
  return contract;
};

const contractEqualityKey = (contract: CallableBorrowContract): string => {
  const cached = contractEqualityKeys.get(contract);
  if (cached) {
    return cached;
  }
  const key = JSON.stringify([
    contract.parameters.map((parameter) => [
      parameter.access,
      parameter.readPaths ?? [],
      parameter.writePaths ?? [],
      parameter.runtimeCheckedWrites ?? false,
      parameter.retained,
      parameter.retainedUnlessBorrowed ?? false,
      parameter.returned,
      parameter.returnedAggregate ?? false,
      parameter.returnedTypeMatchingOrigins ?? [],
      parameter.accessIfResultTypeDiffers ?? null,
      parameter.retainedPaths ?? [],
      parameter.externalRetainedPaths ?? [],
      parameter.borrowedRetainedPaths ?? [],
      parameter.returnedPaths ?? [],
      parameter.returnedOrigins ?? [],
      parameter.returnedSharedOrigins ?? [],
      parameter.invalidatedPaths ?? [],
      parameter.defaultOrigins ?? [],
      parameter.defaultReadOrigins ?? [],
      parameter.defaultWriteOrigins ?? [],
      parameter.defaultExternalOrigins ?? [],
      parameter.defaultExternalReturnedOrigins ?? [],
      parameter.defaultExternalRead ?? false,
      parameter.defaultExternalWrite ?? false,
      parameter.defaultBorrowedResult ?? null,
      parameter.defaultNoBorrowPaths ?? [],
    ]),
    contract.maySuspend,
    contract.freshResult ?? false,
    contract.defaultIdentityGuardProtocol ?? null,
    contract.borrowedResult ?? "external",
    contract.externalReturnedOrigins ?? [],
    contract.externalRead ?? false,
    contract.externalWrite ?? false,
    contract.transfers ?? [],
    contract.scopedCallbacks ?? [],
  ]);
  contractEqualityKeys.set(contract, key);
  return key;
};

export const callableBorrowContractsEqual = (
  left: CallableBorrowContract,
  right: CallableBorrowContract,
): boolean =>
  left === right || contractEqualityKey(left) === contractEqualityKey(right);

const MAX_SUMMARY_PROJECTION_DEPTH = 8;
const MAX_SUMMARY_PATHS_PER_PARAMETER = 32;

const projectionPathsOrBroad = (
  paths: readonly (readonly PlaceProjection[])[] | undefined,
): readonly (readonly PlaceProjection[])[] | undefined => {
  if (!paths || paths.length === 0) {
    return undefined;
  }
  if (
    paths.some((path) => path.length === 0) ||
    paths.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
    paths.some((path) => path.length > MAX_SUMMARY_PROJECTION_DEPTH)
  ) {
    return [[]];
  }
  return paths;
};

const returnedOriginsOrBroad = (
  origins: CallableParameterBorrowContract["returnedOrigins"],
): CallableParameterBorrowContract["returnedOrigins"] => {
  if (!origins || origins.length === 0) {
    return undefined;
  }
  if (
    origins.some(
      (origin) => origin.source.length === 0 && origin.result.length === 0,
    ) ||
    origins.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
    origins.some(
      (origin) =>
        origin.source.length > MAX_SUMMARY_PROJECTION_DEPTH ||
        origin.result.length > MAX_SUMMARY_PROJECTION_DEPTH,
    )
  ) {
    const endpointAccesses = new Map(
      origins.map((origin) => [
        origin.endpointAccess ?? "unknown",
        origin.endpointAccess,
      ]),
    );
    return Array.from(endpointAccesses.values(), (endpointAccess) => ({
      source: [],
      result: [],
      ...(endpointAccess ? { endpointAccess } : {}),
    }));
  }
  return origins;
};

const returnedOriginsWereBroadened = (
  origins: CallableParameterBorrowContract["returnedOrigins"],
): boolean =>
  origins !== undefined &&
  origins.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
  origins?.some(
    (origin) =>
      origin.source.length > MAX_SUMMARY_PROJECTION_DEPTH ||
      origin.result.length > MAX_SUMMARY_PROJECTION_DEPTH,
  ) === true;

const externalOriginsOrBroad = (
  origins: CallableBorrowContract["externalReturnedOrigins"] | undefined,
): CallableBorrowContract["externalReturnedOrigins"] => {
  if (!origins || origins.length === 0) {
    return undefined;
  }
  const freshProjections = origins.filter(
    (origin) => origin.fresh === true && origin.result.length > 0,
  );
  if (
    origins.some((origin) => origin.result.length === 0) ||
    origins.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
    origins.some(
      (origin) => origin.result.length > MAX_SUMMARY_PROJECTION_DEPTH,
    )
  ) {
    const broadened = Array.from(
      new Set(
        origins
          .filter(
            (origin) => origin.fresh !== true || origin.result.length === 0,
          )
          .map((origin) =>
          JSON.stringify([
            origin.endpointAccess ?? "inline",
            origin.fresh ?? false,
          ]),
          ),
      ),
      (serialized) => {
        const [endpointAccess, fresh] = JSON.parse(serialized) as [
          "inline" | "dereferenced",
          boolean,
        ];
        return {
          result: [],
          endpointAccess,
          ...(fresh ? { fresh: true as const } : {}),
        };
      },
    );
    return [
      ...broadened,
      ...freshProjections.filter(
        (origin) =>
          !broadened.some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(origin),
          ),
      ),
    ];
  }
  return origins;
};

export const normalizeReturnedSharedOrigins = (
  origins: CallableParameterBorrowContract["returnedSharedOrigins"],
): CallableParameterBorrowContract["returnedSharedOrigins"] => {
  if (
    !origins ||
    origins.length === 0 ||
    origins.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
    origins.some(
      (origin) =>
        origin.source.length > MAX_SUMMARY_PROJECTION_DEPTH ||
        origin.result.length > MAX_SUMMARY_PROJECTION_DEPTH,
    )
  ) {
    return undefined;
  }
  return origins;
};

const normalizeCallableBorrowContract = (
  contract: CallableBorrowContract,
): CallableBorrowContract => {
  const {
    transfers: _transfers,
    externalReturnedOrigins: _externalReturnedOrigins,
    ...baseContract
  } = contract;
  const transfers = normalizeCallableBorrowTransfers(contract.transfers);
  const normalizedExternalReturnedOrigins = externalOriginsOrBroad(
    contract.externalReturnedOrigins,
  );
  const normalizedReturnedOrigins = contract.parameters.map((parameter) =>
    returnedOriginsOrBroad(parameter.returnedOrigins),
  );
  const normalizedTypeConditions = contract.parameters.map(
    (parameter, index) => {
      const conditions = parameter.returnedTypeMatchingOrigins;
      if (
        !conditions ||
        conditions.length === 0 ||
        conditions.length > MAX_SUMMARY_PATHS_PER_PARAMETER ||
        conditions.some(
          (condition) =>
            condition.source.length > MAX_SUMMARY_PROJECTION_DEPTH ||
            condition.result.length > MAX_SUMMARY_PROJECTION_DEPTH,
        )
      ) {
        return undefined;
      }
      const returnedOrigins = normalizedReturnedOrigins[index];
      return conditions.filter((condition) =>
        returnedOrigins?.some(
          (origin) =>
            JSON.stringify(origin.source) ===
              JSON.stringify(condition.source) &&
            JSON.stringify(origin.result) ===
              JSON.stringify(condition.result) &&
            origin.endpointAccess === condition.endpointAccess,
        ),
      );
    },
  );
  return {
    ...baseContract,
    parameters: contract.parameters.map((parameter, index) => {
      const {
        readPaths: _readPaths,
        writePaths: _writePaths,
        invalidatedPaths: _invalidatedPaths,
        externalRetainedPaths: _externalRetainedPaths,
        borrowedRetainedPaths: _borrowedRetainedPaths,
        returnedSharedOrigins: _returnedSharedOrigins,
        returnedTypeMatchingOrigins: _returnedConditions,
        accessIfResultTypeDiffers: _accessCondition,
        defaultExternalOrigins: _defaultExternalOrigins,
        defaultExternalReturnedOrigins: _defaultExternalReturnedOrigins,
        ...baseParameter
      } = parameter;
      const readPaths =
        parameter.readPaths === undefined
          ? undefined
          : minimizeProjectionPaths(
              projectionPathsOrBroad(parameter.readPaths) ?? [],
            );
      const writePaths =
        parameter.writePaths === undefined
          ? undefined
          : minimizeProjectionPaths(
              projectionPathsOrBroad(parameter.writePaths) ?? [],
            );
      const retainedPaths = projectionPathsOrBroad(parameter.retainedPaths);
      const externalRetainedPaths = projectionPathsOrBroad(
        parameter.externalRetainedPaths,
      );
      const borrowedRetainedPaths = projectionPathsOrBroad(
        parameter.borrowedRetainedPaths,
      );
      const returnedPaths = projectionPathsOrBroad(parameter.returnedPaths);
      const returnedOrigins = normalizedReturnedOrigins[index];
      const returnedAggregate =
        parameter.returnedAggregate === true ||
        returnedOriginsWereBroadened(parameter.returnedOrigins);
      const returnedSharedOrigins = normalizeReturnedSharedOrigins(
        parameter.returnedSharedOrigins,
      );
      const returnedTypeMatchingOrigins = normalizedTypeConditions[index];
      const accessIfResultTypeDiffers = parameter.accessIfResultTypeDiffers;
      const validAccessCondition =
        accessIfResultTypeDiffers &&
        normalizedTypeConditions[accessIfResultTypeDiffers.parameter]?.some(
          (condition) =>
            condition.conditionId === accessIfResultTypeDiffers.conditionId &&
            JSON.stringify(condition.source) ===
              JSON.stringify(accessIfResultTypeDiffers.sourcePath) &&
            JSON.stringify(condition.result) ===
              JSON.stringify(accessIfResultTypeDiffers.resultPath),
        )
          ? accessIfResultTypeDiffers
          : undefined;
      const invalidatedPaths =
        (parameter.invalidatedPaths?.length ?? 0) <=
          MAX_SUMMARY_PATHS_PER_PARAMETER &&
        parameter.invalidatedPaths?.every(
          (path) => path.length <= MAX_SUMMARY_PROJECTION_DEPTH,
        )
          ? parameter.invalidatedPaths
          : undefined;
      const defaultExternalOrigins = externalOriginsOrBroad(
        parameter.defaultExternalOrigins,
      );
      const defaultExternalReturnedOrigins = externalOriginsOrBroad(
        parameter.defaultExternalReturnedOrigins,
      );
      return {
        ...baseParameter,
        ...(readPaths !== undefined ? { readPaths } : {}),
        ...(writePaths !== undefined ? { writePaths } : {}),
        ...(retainedPaths ? { retainedPaths } : {}),
        ...(externalRetainedPaths ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths ? { borrowedRetainedPaths } : {}),
        ...(returnedPaths ? { returnedPaths } : {}),
        ...(returnedOrigins ? { returnedOrigins } : {}),
        ...(returnedAggregate ? { returnedAggregate: true as const } : {}),
        ...(returnedSharedOrigins ? { returnedSharedOrigins } : {}),
        ...(returnedTypeMatchingOrigins?.length
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(validAccessCondition
          ? { accessIfResultTypeDiffers: validAccessCondition }
          : {}),
        ...(invalidatedPaths ? { invalidatedPaths } : {}),
        ...(defaultExternalOrigins ? { defaultExternalOrigins } : {}),
        ...(defaultExternalReturnedOrigins
          ? { defaultExternalReturnedOrigins }
          : {}),
      };
    }),
    ...(normalizedExternalReturnedOrigins
      ? { externalReturnedOrigins: normalizedExternalReturnedOrigins }
      : {}),
    ...(transfers.length > 0 ? { transfers } : {}),
  };
};

const joinCallableBorrowContracts = ({
  previous,
  candidate,
}: {
  previous: CallableBorrowContract;
  candidate: CallableBorrowContract;
}): CallableBorrowContract => {
  const merged = mergeCallableBorrowContracts([previous, candidate]);
  if (!merged) {
    throw new Error("borrow contract join requires at least one contract");
  }
  return normalizeCallableBorrowContract({
    ...merged,
    ...(previous.freshResult || candidate.freshResult
      ? { freshResult: true as const }
      : {}),
    parameters: merged.parameters.map((parameter, index) => {
      const invalidatedPaths = Array.from(
        new Map(
          [
            ...(previous.parameters[index]?.invalidatedPaths ?? []),
            ...(candidate.parameters[index]?.invalidatedPaths ?? []),
          ].map((path) => [JSON.stringify(path), path]),
        ).values(),
      );
      const {
        returnedSharedOrigins: _returnedSharedOrigins,
        ...withoutSharedOrigins
      } = parameter;
      return {
        ...withoutSharedOrigins,
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
      };
    }),
  });
};

const narrowDerivedAccessFacts = ({
  contract,
  candidate,
}: {
  contract: CallableBorrowContract;
  candidate: CallableBorrowContract;
}): CallableBorrowContract => {
  const {
    freshResult: _freshResult,
    externalRead: _externalRead,
    externalWrite: _externalWrite,
    borrowedResult: _borrowedResult,
    ...baseContract
  } = contract;
  return {
    ...baseContract,
    parameters: contract.parameters.map((parameter, index) => {
      const {
        runtimeCheckedWrites: _runtimeCheckedWrites,
        retainedUnlessBorrowed: _retainedUnlessBorrowed,
        defaultBorrowedResult: _defaultBorrowedResult,
        defaultNoBorrowPaths: _defaultNoBorrowPaths,
        ...baseParameter
      } = parameter;
      return {
        ...baseParameter,
        ...(candidate.parameters[index]?.runtimeCheckedWrites
          ? { runtimeCheckedWrites: true as const }
          : {}),
        ...(candidate.parameters[index]?.retainedUnlessBorrowed
          ? { retainedUnlessBorrowed: true as const }
          : {}),
        ...(candidate.parameters[index]?.defaultBorrowedResult === "none"
          ? { defaultBorrowedResult: "none" as const }
          : {}),
        ...((candidate.parameters[index]?.defaultNoBorrowPaths?.length ?? 0) > 0
          ? {
              defaultNoBorrowPaths:
                candidate.parameters[index]!.defaultNoBorrowPaths,
            }
          : {}),
      };
    }),
    borrowedResult: candidate.borrowedResult ?? "none",
    ...(candidate.freshResult ? { freshResult: true as const } : {}),
    ...(candidate.externalRead ? { externalRead: true as const } : {}),
    ...(candidate.externalWrite ? { externalWrite: true as const } : {}),
  };
};

const withoutImpossibleWritePaths = ({
  contract,
  functionItem,
  typing,
}: {
  contract: CallableBorrowContract;
  functionItem: HirFunction;
  typing: TypingResult;
}): CallableBorrowContract => {
  const signature = typing.functions.getSignature(functionItem.symbol);
  if (!signature) {
    return contract;
  }
  return {
    ...contract,
    parameters: contract.parameters.map((parameter, index) => {
      if (!parameter.writePaths) {
        return parameter;
      }
      const parameterType = signature.parameters[index]?.type;
      if (typeof parameterType !== "number") {
        return parameter;
      }
      const descriptor = typing.arena.get(parameterType);
      const hasClosedProjectionShape =
        descriptor.kind === "fixed-array" ||
        descriptor.kind === "nominal-object" ||
        descriptor.kind === "value-object" ||
        descriptor.kind === "structural-object" ||
        descriptor.kind === "intersection";
      if (!hasClosedProjectionShape) {
        return parameter;
      }
      const writePaths = parameter.writePaths.filter((path) => {
        const firstProjectionIndex = path.findIndex(
          (projection) => projection.kind !== "dereference",
        );
        if (firstProjectionIndex < 0) {
          return true;
        }
        const projection = path[firstProjectionIndex]!;
        if (
          projection.kind !== "field" &&
          projection.kind !== "tuple" &&
          projection.kind !== "index"
        ) {
          return true;
        }
        return (
          projectedTypes(
            parameterType,
            path.slice(0, firstProjectionIndex + 1),
            typing,
          ).length > 0
        );
      });
      return writePaths.length === parameter.writePaths.length
        ? parameter
        : { ...parameter, writePaths };
    }),
  };
};

const withReturnedSharedOrigins = ({
  contract,
  candidate,
}: {
  contract: CallableBorrowContract;
  candidate: CallableBorrowContract;
}): CallableBorrowContract => ({
  ...contract,
  parameters: contract.parameters.map((parameter, index) => {
    const {
      returnedSharedOrigins: _returnedSharedOrigins,
      ...withoutSharedOrigins
    } = parameter;
    const returnedSharedOrigins = normalizeReturnedSharedOrigins(
      candidate.parameters[index]?.returnedSharedOrigins,
    );
    return {
      ...withoutSharedOrigins,
      ...(returnedSharedOrigins ? { returnedSharedOrigins } : {}),
    };
  }),
});

const callersWithTraitDispatch = ({
  callers,
  functions,
  typing,
}: {
  callers: ReadonlyMap<SymbolId, readonly HirFunction[]>;
  functions: readonly HirFunction[];
  typing: TypingResult;
}): ReadonlyMap<SymbolId, readonly HirFunction[]> => {
  const result = new Map(
    Array.from(callers, ([target, dependents]) => [target, [...dependents]]),
  );
  const localFunctions = new Set(
    functions.map((functionItem) => functionItem.symbol),
  );
  typing.traitMethodImpls.forEach((mapping, implementation) => {
    if (!localFunctions.has(implementation)) {
      return;
    }
    const dependents = result.get(implementation) ?? [];
    (callers.get(mapping.traitMethodSymbol) ?? []).forEach((caller) => {
      if (!dependents.some((entry) => entry.symbol === caller.symbol)) {
        dependents.push(caller);
      }
    });
    if (dependents.length > 0) {
      result.set(implementation, dependents);
    }
  });
  return result;
};

export type BorrowSummaryDemandTelemetry = {
  totalCallables: number;
  demandedCallables: number;
  skippedTrivialCallables: number;
  worklistEdges: number;
  worklistIterations: number;
  evaluations: number;
};

export type CallableBorrowContractComputation = {
  contracts: Map<SymbolId, CallableBorrowContract>;
  lambdaContracts: ReadonlyMap<HirExprId, CallableBorrowContract>;
  queries: ReadonlyMap<
    SymbolId,
    {
      input: string;
      dependencies: readonly SymbolRef[];
      output: CallableBorrowContract;
    }
  >;
  demand: BorrowSummaryDemandTelemetry & {
    demandedSymbols: ReadonlySet<SymbolId>;
  };
};

export const computeCallableBorrowContracts = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  facts: providedFacts,
  dynamicDispatchContracts = new Map(),
  declarationContracts = new Map(),
  lambdaFacts,
  initialContracts,
  flowSymbols,
  dirtySymbols,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: SymbolRef;
  }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  facts: ReadonlyMap<SymbolId, CallableBorrowFacts>;
  dynamicDispatchContracts?: ReadonlyMap<SymbolId, CallableBorrowContract>;
  declarationContracts?: ReadonlyMap<SymbolId, CallableBorrowContract>;
  lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts>;
  /** Contracts produced by the capability/index paths seed the flow solve. */
  initialContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  /** Only flow-sensitive callables may reach full contract inference. */
  flowSymbols: ReadonlySet<SymbolId>;
  /** Newly promoted symbols; their flow-sensitive callers are recomputed. */
  dirtySymbols?: ReadonlySet<SymbolId>;
}): CallableBorrowContractComputation => {
  const withDynamicDispatch = (
    symbol: SymbolId,
    contract: CallableBorrowContract,
  ): CallableBorrowContract => {
    const dynamicDispatch = dynamicDispatchContracts.get(symbol);
    return dynamicDispatch ? { ...contract, dynamicDispatch } : contract;
  };
  const functions = Array.from(hir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  const lambdas = Array.from(hir.expressions.values()).filter(
    (expression): expression is HirLambdaExpr =>
      expression.exprKind === "lambda",
  );
  const analysisFunctions = functions.filter((functionItem) =>
    flowSymbols.has(functionItem.symbol),
  );
  const analysisLambdas = lambdas.filter((lambda) => {
    return flowSymbols.has((-1 - lambda.id) as SymbolId);
  });
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const contracts = new Map<SymbolId, CallableBorrowContract>([
    ...functions.map(
      (functionItem) =>
        [
          functionItem.symbol,
          withDynamicDispatch(
            functionItem.symbol,
            initialContracts?.get(functionItem.symbol) ??
              initialFunctionContract({
                functionItem,
                typing,
                symbolTable,
              }),
          ),
        ] as const,
    ),
    ...lambdas.map(
      (lambda) =>
        [
          (-1 - lambda.id) as SymbolId,
          initialContracts?.get((-1 - lambda.id) as SymbolId) ??
            initialLambdaContract(lambda, typing),
        ] as const,
    ),
  ]);
  declarationContracts.forEach((contract, symbol) => {
    // Trait defaults are represented as synthetic functions with the same
    // symbol as their declaration. Start those summaries from the declared
    // public contract so the conservative initial function seed does not
    // permanently fabricate root access or external provenance. Inference
    // still joins any additional body behavior, which the declaration
    // validator reports as an excess.
    contracts.set(symbol, withDynamicDispatch(symbol, contract));
  });
  const facts = providedFacts;
  const effectiveLambdaFacts = lambdaFacts;
  const allCallers = callersWithTraitDispatch({
    callers: localCallersOf({
      functions: analysisFunctions,
      facts,
      moduleId,
    }),
    functions: analysisFunctions,
    typing,
  });
  // Capability classification is the only routing decision. The compact
  // path has already published contracts for every non-flow callable; this
  // solve owns only the full facts supplied for flow-sensitive callables.
  const summaryFunctions = analysisFunctions;
  const demandedLambdas = analysisLambdas;
  const selection = {
    demanded: new Set<SymbolId>([
      ...summaryFunctions.map((functionItem) => functionItem.symbol),
      ...demandedLambdas.map(
        (lambda) => effectiveLambdaFacts.get(lambda.id)!.symbol,
      ),
    ]),
    worklistEdges: 0,
    worklistIterations: 0,
    boundaryRoots: 0,
    ambientRoots: 0,
    initialAmbientRoots: 0,
  };
  incrementCompilerPerfCounter(
    "borrowing.summary.totalCallables",
    functions.length + lambdas.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandedCallables",
    summaryFunctions.length + demandedLambdas.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.skippedTrivialCallables",
    functions.length +
      lambdas.length -
      summaryFunctions.length -
      demandedLambdas.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandWorklistEdges",
    selection.worklistEdges,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandWorklistIterations",
    selection.worklistIterations,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandBoundaryRoots",
    selection.boundaryRoots,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandAmbientCallables",
    selection.ambientRoots,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.demandAmbientRoots",
    selection.initialAmbientRoots,
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.functions",
    summaryFunctions.length,
  );
  const summarySymbols = new Set([
    ...summaryFunctions.map((functionItem) => functionItem.symbol),
    ...demandedLambdas.map(
      (lambda) => effectiveLambdaFacts.get(lambda.id)!.symbol,
    ),
  ]);
  type SummarySolveNode =
    | {
        symbol: SymbolId;
        functionItem: HirFunction;
        facts: CallableBorrowFacts;
      }
    | { symbol: SymbolId; lambda: HirLambdaExpr; facts: CallableBorrowFacts };
  const solveNodes: SummarySolveNode[] = [
    ...summaryFunctions.map((functionItem) => ({
      symbol: functionItem.symbol,
      functionItem,
      facts: facts.get(functionItem.symbol)!,
    })),
    ...demandedLambdas.map((lambda) => ({
      symbol: effectiveLambdaFacts.get(lambda.id)!.symbol,
      lambda,
      facts: effectiveLambdaFacts.get(lambda.id)!,
    })),
  ];
  const solveNodeBySymbol = new Map(
    solveNodes.map((node) => [node.symbol, node]),
  );
  const callers = new Map<SymbolId, SummarySolveNode[]>();
  const invalidationCallers = new Map<SymbolId, SummarySolveNode[]>();
  const addInvalidationCaller = (
    target: SymbolId,
    dependent: SummarySolveNode,
  ): void => {
    const current = invalidationCallers.get(target) ?? [];
    if (!current.some((candidate) => candidate.symbol === dependent.symbol)) {
      current.push(dependent);
      invalidationCallers.set(target, current);
    }
  };
  const addCaller = (target: SymbolId, dependent: SummarySolveNode): void => {
    addInvalidationCaller(target, dependent);
    if (!summarySymbols.has(target)) return;
    const current = callers.get(target) ?? [];
    if (!current.some((candidate) => candidate.symbol === dependent.symbol)) {
      current.push(dependent);
      callers.set(target, current);
    }
  };
  allCallers.forEach((dependents, target) =>
    dependents.forEach((dependent) => {
      const node = solveNodeBySymbol.get(dependent.symbol);
      if (node) addCaller(target, node);
    }),
  );
  solveNodes.forEach((node) => {
    node.facts.dependencies.forEach((target) => {
      if (target.moduleId === moduleId) addCaller(target.symbol, node);
    });
    node.facts.expressionIds.forEach((exprId) => {
      const expression = node.facts.expressions.get(exprId);
      if (expression?.exprKind !== "lambda") return;
      const nested = effectiveLambdaFacts.get(expression.id);
      if (nested) addCaller(nested.symbol, node);
    });
  });
  const orderedSummaryNodes = dependencyOrderedSolveNodes(solveNodes, callers);
  const dirtySummarySymbols = new Set<SymbolId>(
    dirtySymbols === undefined
      ? summarySymbols
      : Array.from(dirtySymbols).filter((symbol) =>
          summarySymbols.has(symbol),
        ),
  );
  const dirtyWorklist =
    dirtySymbols === undefined ? [...summarySymbols] : [...dirtySymbols];
  for (let cursor = 0; cursor < dirtyWorklist.length; cursor += 1) {
    (invalidationCallers.get(dirtyWorklist[cursor]!) ?? []).forEach(
      (dependent) => {
        if (dirtySummarySymbols.has(dependent.symbol)) return;
        dirtySummarySymbols.add(dependent.symbol);
        dirtyWorklist.push(dependent.symbol);
      },
    );
  }
  const localSummaryDependencies = new Map<SymbolId, Set<SymbolId>>();
  callers.forEach((dependents, target) => {
    if (!summarySymbols.has(target)) {
      return;
    }
    dependents.forEach((dependent) => {
      const targets =
        localSummaryDependencies.get(dependent.symbol) ?? new Set<SymbolId>();
      targets.add(target);
      localSummaryDependencies.set(dependent.symbol, targets);
    });
  });
  let evaluationCount = 0;
  const summarize = (node: SummarySolveNode): CallableBorrowContract => {
    evaluationCount += 1;
    return "functionItem" in node
      ? summarizeFunction({
          functionItem: node.functionItem,
          facts: node.facts,
          lambdaFacts: effectiveLambdaFacts,
          baseContracts: contracts,
          hir,
          typing,
          symbolTable,
          moduleId,
          imports: importMap,
          dependencies,
          decls,
        })
      : summarizeLambdaBorrowing({
          lambda: node.lambda,
          facts: node.facts,
          lambdaFacts: effectiveLambdaFacts,
          hir,
          typing,
          symbolTable,
          moduleId,
          imports: importMap,
          dependencies,
          contracts,
          decls,
        });
  };
  const solveWorklist = orderedSummaryNodes.filter((node) =>
    dirtySummarySymbols.has(node.symbol),
  );
  const solveQueued = new Set(solveWorklist.map((node) => node.symbol));
  let solveCursor = 0;
  while (solveCursor < solveWorklist.length) {
    const node = solveWorklist[solveCursor++]!;
    solveQueued.delete(node.symbol);
    const previous = contracts.get(node.symbol)!;
    const candidate = summarize(node);
    const declared = declarationContracts.get(node.symbol);
    const evidence = declared
      ? joinCallableBorrowContracts({ previous: declared, candidate })
      : candidate;
    const joined = joinCallableBorrowContracts({
      previous,
      candidate: evidence,
    });
    const narrowed = narrowDerivedAccessFacts({
      contract: joined,
      candidate: evidence,
    });
    const normalized =
      "functionItem" in node
        ? withoutImpossibleWritePaths({
            functionItem: node.functionItem,
            typing,
            contract: narrowed,
          })
        : narrowed;
    const next = withDynamicDispatch(
      node.symbol,
      withReturnedSharedOrigins({ contract: normalized, candidate: evidence }),
    );
    if (callableBorrowContractsEqual(previous, next)) {
      incrementCompilerPerfCounter("borrowing.summary.unchangedCandidates");
      continue;
    }
    contracts.set(node.symbol, next);
    (callers.get(node.symbol) ?? []).forEach((dependent) => {
      if (solveQueued.has(dependent.symbol)) {
        return;
      }
      solveQueued.add(dependent.symbol);
      solveWorklist.push(dependent);
    });
  }
  const functionsBySymbol = new Map(
    functions.map((functionItem) => [functionItem.symbol, functionItem]),
  );
  const lambdaSymbols = new Set(
    lambdas.map((lambda) => (-1 - lambda.id) as SymbolId),
  );
  const result = new Map(
    Array.from(contracts, ([symbol, contract]) => {
      if (lambdaSymbols.has(symbol)) return undefined;
      const {
        defaultIdentityGuardProtocol: _defaultIdentityGuardProtocol,
        ...baseContract
      } = contract;
      const functionItem = functionsBySymbol.get(symbol);
      const hasDefault =
        functionItem?.parameters.some(
          (parameter) => typeof parameter.defaultValue === "number",
        ) === true;
      const canRequireIdentityGuard =
        hasDefault && callableContractHasGuardableAccessPair(contract);
      return [
        symbol,
        canRequireIdentityGuard
          ? {
              ...baseContract,
              defaultIdentityGuardProtocol: "presence-conflict-bit-v1" as const,
            }
          : baseContract,
      ] as const;
    }).filter(
      (entry): entry is readonly [SymbolId, CallableBorrowContract] =>
        entry !== undefined,
    ),
  );
  const resolvedLambdaContracts = new Map(
    lambdas.flatMap((lambda) => {
      const contract = contracts.get((-1 - lambda.id) as SymbolId);
      return contract ? [[lambda.id, contract] as const] : [];
    }),
  );
  incrementCompilerPerfCounter(
    "borrowing.contract.inferredCount",
    summaryFunctions.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.contract.fullEvaluations",
    evaluationCount,
  );
  const detailedCallables = summaryFunctions.length + demandedLambdas.length;
  incrementCompilerPerfCounter(
    "borrowing.summary.effectiveDetailedCallables",
    detailedCallables,
  );
  return {
    contracts: result,
    lambdaContracts: resolvedLambdaContracts,
    queries: new Map(
      Array.from(
        new Map<SymbolId, CallableBorrowContract>([
          ...result,
          ...lambdas.flatMap((lambda) => {
            const contract = resolvedLambdaContracts.get(lambda.id);
            return contract
              ? [[(-1 - lambda.id) as SymbolId, contract] as const]
              : [];
          }),
        ]),
        ([symbol, output]) => {
          const callableFacts =
            facts.get(symbol) ??
            Array.from(effectiveLambdaFacts.values()).find(
              (candidate) => candidate.symbol === symbol,
            );
          const queryDependencies = new Map(
            (callableFacts?.dependencies ?? []).map((dependency) => [
              `${dependency.moduleId}:${dependency.symbol}`,
              dependency,
            ]),
          );
          (localSummaryDependencies.get(symbol) ?? []).forEach((dependency) => {
            const target = { moduleId, symbol: dependency };
            queryDependencies.set(`${moduleId}:${dependency}`, target);
          });
          return [
            symbol,
            {
              input: callableFacts?.stableInput ?? `${moduleId}:${symbol}`,
              dependencies: Array.from(queryDependencies.values()),
              output,
            },
          ] as const;
        },
      ),
    ),
    demand: {
      totalCallables: functions.length + lambdas.length,
      demandedCallables: detailedCallables,
      skippedTrivialCallables:
        functions.length + lambdas.length - detailedCallables,
      worklistEdges: selection.worklistEdges,
      worklistIterations: selection.worklistIterations,
      evaluations: evaluationCount,
      demandedSymbols: new Set([
        ...selection.demanded,
        ...demandedLambdas.map(
          (lambda) => effectiveLambdaFacts.get(lambda.id)!.symbol,
        ),
      ]),
    },
  };
};

const stronglyConnectedComponents = ({
  symbols,
  dependents,
  sourceOrder,
}: {
  symbols: readonly SymbolId[];
  dependents: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
  sourceOrder: ReadonlyMap<SymbolId, number>;
}): readonly (readonly SymbolId[])[] => {
  const indices = new Map<SymbolId, number>();
  const lowLinks = new Map<SymbolId, number>();
  const stack: SymbolId[] = [];
  const onStack = new Set<SymbolId>();
  const components: SymbolId[][] = [];
  let nextIndex = 0;
  const visit = (symbol: SymbolId): void => {
    const index = nextIndex++;
    indices.set(symbol, index);
    lowLinks.set(symbol, index);
    stack.push(symbol);
    onStack.add(symbol);
    (dependents.get(symbol) ?? []).forEach((dependent) => {
      if (!indices.has(dependent)) {
        visit(dependent);
        lowLinks.set(
          symbol,
          Math.min(lowLinks.get(symbol)!, lowLinks.get(dependent)!),
        );
        return;
      }
      if (onStack.has(dependent)) {
        lowLinks.set(
          symbol,
          Math.min(lowLinks.get(symbol)!, indices.get(dependent)!),
        );
      }
    });
    if (lowLinks.get(symbol) !== indices.get(symbol)) {
      return;
    }
    const component: SymbolId[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === symbol) {
        break;
      }
    }
    component.sort(
      (left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!,
    );
    components.push(component);
  };
  symbols.forEach((symbol) => {
    if (!indices.has(symbol)) {
      visit(symbol);
    }
  });
  return components;
};

const dependencyOrderedSolveNodes = <T extends { symbol: SymbolId }>(
  functions: readonly T[],
  callers: ReadonlyMap<SymbolId, readonly T[]>,
): readonly T[] => {
  const bySymbol = new Map(
    functions.map((functionItem) => [functionItem.symbol, functionItem]),
  );
  const sourceOrder = new Map(
    functions.map((functionItem, index) => [functionItem.symbol, index]),
  );
  const dependentsByTarget = new Map(
    functions.map((functionItem) => [functionItem.symbol, new Set<SymbolId>()]),
  );
  callers.forEach((callersForTarget, target) => {
    if (!bySymbol.has(target)) {
      return;
    }
    const targetDependents = dependentsByTarget.get(target)!;
    callersForTarget.forEach((dependent) => {
      if (bySymbol.has(dependent.symbol)) {
        targetDependents.add(dependent.symbol);
      }
    });
  });
  const components = stronglyConnectedComponents({
    symbols: functions.map((functionItem) => functionItem.symbol),
    dependents: dependentsByTarget,
    sourceOrder,
  });
  incrementCompilerPerfCounter(
    "borrowing.scc.evaluations",
    components.length,
  );
  const componentBySymbol = new Map<SymbolId, number>();
  components.forEach((component, componentIndex) =>
    component.forEach((symbol) =>
      componentBySymbol.set(symbol, componentIndex),
    ),
  );
  const componentDependents = components.map(() => new Set<number>());
  const indegrees = components.map(() => 0);
  dependentsByTarget.forEach((targets, source) => {
    const sourceComponent = componentBySymbol.get(source)!;
    targets.forEach((target) => {
      const targetComponent = componentBySymbol.get(target)!;
      if (
        sourceComponent === targetComponent ||
        componentDependents[sourceComponent]!.has(targetComponent)
      ) {
        return;
      }
      componentDependents[sourceComponent]!.add(targetComponent);
      indegrees[targetComponent] = indegrees[targetComponent]! + 1;
    });
  });
  const componentSourceOrder = (componentIndex: number): number =>
    sourceOrder.get(components[componentIndex]![0]!)!;
  const worklist = components
    .map((_component, index) => index)
    .filter((index) => indegrees[index] === 0)
    .sort(
      (left, right) => componentSourceOrder(left) - componentSourceOrder(right),
    );
  const orderedComponents: number[] = [];
  while (worklist.length > 0) {
    const componentIndex = worklist.shift()!;
    orderedComponents.push(componentIndex);
    componentDependents[componentIndex]!.forEach((dependent) => {
      indegrees[dependent] = indegrees[dependent]! - 1;
      if (indegrees[dependent] === 0) {
        worklist.push(dependent);
        worklist.sort(
          (left, right) =>
            componentSourceOrder(left) - componentSourceOrder(right),
        );
      }
    });
  }
  return orderedComponents.flatMap((componentIndex) =>
    components[componentIndex]!.map((symbol) => bySymbol.get(symbol)!),
  );
};

const localCallersOf = ({
  functions,
  facts,
  moduleId,
}: {
  functions: readonly HirFunction[];
  facts: ReadonlyMap<SymbolId, CallableBorrowFacts>;
  moduleId: string;
}): ReadonlyMap<SymbolId, readonly HirFunction[]> => {
  const byTarget = new Map<SymbolId, HirFunction[]>();
  functions.forEach((caller) => {
    facts.get(caller.symbol)?.dependencies.forEach((target) => {
      if (target.moduleId !== moduleId) {
        return;
      }
      const current = byTarget.get(target.symbol) ?? [];
      if (!current.some((entry) => entry.symbol === caller.symbol)) {
        current.push(caller);
        byTarget.set(target.symbol, current);
      }
    });
  });
  return byTarget;
};

const summarizeLambdaBorrowing = ({
  lambda,
  facts,
  lambdaFacts,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  contracts,
  decls,
}: {
  lambda: HirLambdaExpr;
  facts: CallableBorrowFacts;
  lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  decls: DeclTable;
}): CallableBorrowContract => {
  const accessed = emptyFlow();
  const written = emptyFlow();
  const uncheckedWritten = emptyFlow();
  const retained = emptyFlow();
  const externalRetained = emptyFlow();
  const borrowedRetained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map<string, ScopedCallbackBorrowContract>();
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const placeEnvs = new Map<MutableEnv, Map<SymbolId, MutableFlow>>();
  const expressionFlows = new Map<MutableEnv, Map<HirExprId, MutableFlow>>();
  const localOwnedRoots = new Set<SymbolId>();
  const invalidated = new Map<MutableEnv, MutableFlow>();
  const returnSnapshots: ReturnSnapshot[] = [];
  const freshReturns: boolean[] = [];
  const transfers = new Map<string, CallableBorrowTransfer>();
  const lambdaType = typing.resolvedExprTypes.get(lambda.id);
  const lambdaDescriptor =
    typeof lambdaType === "number" ? typing.arena.get(lambdaType) : undefined;
  const lambdaSignature =
    lambdaDescriptor?.kind === "function" ? lambdaDescriptor : undefined;
  const parameterFlows = new Map(
    lambda.parameters.map((parameter, index) => [
      index,
      flowWithExplicitBorrowedOrigins({
        flow: parameterFlowForPattern({
          parameter: index,
          pattern: parameter.pattern,
          typing,
        }),
        parameter: index,
        type: lambdaSignature?.parameters[index]?.type,
        typing,
      }),
    ]),
  );
  const lambdaReturnType = lambdaSignature?.returnType;
  const parameterSymbolFlows = new Map<SymbolId, Flow>();
  const env: MutableEnv = new Map();
  invalidated.set(env, emptyFlow());
  placeEnvs.set(env, new Map());
  expressionFlows.set(env, new Map());
  externalModuleBindingFlows(hir, typing, imports, dependencies).forEach(
    (flow, symbol) => env.set(symbol, new Map(flow)),
  );
  lambda.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlows.get(index)!, env);
    patternSymbols(parameter.pattern).forEach((symbol) => {
      parameterOrigins.set(symbol, index);
      parameterSymbolFlows.set(symbol, new Map(env.get(symbol) ?? emptyFlow()));
    });
    mutablePatternSymbols(parameter.pattern).forEach((symbol) =>
      placeEnvs.get(env)!.set(symbol, new Map(env.get(symbol) ?? emptyFlow())),
    );
  });
  const ctx: SummaryContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    contracts,
    borrowIndexMode: "symbolic",
    accessed,
    written,
    uncheckedWritten,
    retained,
    externalRetained,
    borrowedRetained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    callResolutionCache: new Map(),
    parameterOrigins,
    parameterSymbolFlows,
    placeEnvs,
    expressionFlows,
    localOwnedRoots,
    invalidated,
    returnSnapshots,
    freshReturns,
    borrowedReturnType: lambdaReturnType,
    borrowedReturnPaths:
      typeof lambdaReturnType === "number"
        ? borrowedPathsInType(lambdaReturnType, typing)
        : [],
    transfers,
    decls,
    facts,
    lambdaFacts,
  };
  evaluateFactRoot(lambda.body, env, ctx);
  const definitelyInvalidated = intersectFlows(
    returnSnapshots.map((snapshot) => snapshot.invalidated),
  );
  const escapingRetained = escapingRetainedOrigins({
    retained,
    returned,
    transfers: transfers.values(),
  });
  const returnedExternalOrigins = externalReturnedOrigins(returned);
  return {
    parameters: lambda.parameters.map((parameter, index) => {
      const directlyRetainedPaths = pathsForParameter(escapingRetained, index);
      const externalRetainedPaths = pathsForParameter(externalRetained, index);
      const retainedPaths = mergePaths(
        directlyRetainedPaths,
        externalRetainedPaths,
      );
      const retainedOrigins = originsForParameter(escapingRetained, index);
      const externalRetainedOrigins = originsForParameter(
        externalRetained,
        index,
      );
      const retainedUnlessBorrowed =
        retainedPaths.length > 0 &&
        [...retainedOrigins, ...externalRetainedOrigins].every(
          (origin) => origin.retainedUnlessBorrowed === true,
        );
      const borrowedRetainedPaths = pathsForParameter(borrowedRetained, index);
      const returnedContractOrigins = returnedContractOriginsForParameter(
        returned,
        index,
      );
      const returnedOrigins = returnedContractOrigins.origins;
      const invalidatedPaths = pathsForParameter(definitelyInvalidated, index);
      const returnedSharedOrigins = returnedSharedOriginsForParameter({
        returned,
        returnSnapshots,
        parameter: index,
      }).map((origin) => ({
        source: origin.sourceProjections,
        result: origin.resultProjections,
        endpointAccess: origin.sourceEndpointAccess,
      }));
      const completeReturnedOrigins = Array.from(
        new Map(
          [...returnedOrigins, ...returnedSharedOrigins].map((origin) => [
            JSON.stringify(origin),
            origin,
          ]),
        ).values(),
      );
      const parameterType = lambdaSignature?.parameters[index]?.type;
      const access =
        parameter.pattern.bindingKind === "mutable-ref"
          ? "mutable"
          : typeof parameterType === "number" &&
              !typeCanCarryReference(parameterType, typing)
            ? "owned"
            : "shared";
      const readPaths = minimizeProjectionPaths(
        pathsForParameter(accessed, index),
      );
      const writePaths = minimizeProjectionPaths(
        pathsForParameter(written, index),
      );
      const hasUncheckedWrites =
        pathsForParameter(uncheckedWritten, index).length > 0;
      const accessCondition = accessConditionForParameter(
        accessed,
        returned,
        index,
      );
      const returnedTypeMatchingOrigins = returnedContractOrigins.typeMatching;
      return {
        access,
        ...(readPaths.length > 0 ? { readPaths } : {}),
        ...(writePaths.length > 0 ? { writePaths } : {}),
        ...(writePaths.length > 0 && !hasUncheckedWrites
          ? { runtimeCheckedWrites: true as const }
          : {}),
        ...(accessCondition
          ? { accessIfResultTypeDiffers: accessCondition }
          : {}),
        retained: retainedPaths.length > 0,
        ...(retainedUnlessBorrowed
          ? { retainedUnlessBorrowed: true as const }
          : {}),
        returned: completeReturnedOrigins.length > 0,
        ...(returnedTypeMatchingOrigins.length > 0
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(externalRetainedPaths.length > 0 ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths.length > 0 ? { borrowedRetainedPaths } : {}),
        ...(completeReturnedOrigins.length > 0
          ? { returnedOrigins: completeReturnedOrigins }
          : {}),
        ...(returnedSharedOrigins.length > 0 ? { returnedSharedOrigins } : {}),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
      };
    }),
    maySuspend: maySuspend.value,
    borrowedResult: borrowedResultPresenceFromFlow({
      flow: returned,
      type: lambdaReturnType,
      typing,
    }),
    ...(freshReturns.length > 0 && freshReturns.every(Boolean)
      ? { freshResult: true as const }
      : {}),
    ...(flowHasUnconditionalExternalOrigin(accessed)
      ? { externalRead: true as const }
      : {}),
    ...(flowHasUnconditionalExternalOrigin(written)
      ? { externalWrite: true as const }
      : {}),
    ...(returnedExternalOrigins.length > 0
      ? { externalReturnedOrigins: returnedExternalOrigins }
      : {}),
    ...(transfers.size > 0
      ? { transfers: Array.from(transfers.values()) }
      : {}),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
};
