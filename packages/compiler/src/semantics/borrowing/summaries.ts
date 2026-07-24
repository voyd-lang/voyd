import type { SymbolTable } from "../binder/index.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import {
  walkExpression,
  type HirExpression,
  type HirBlockExpr,
  type HirEffectHandlerExpr,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirMatchExpr,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import type {
  BorrowTypeComparison,
  CallableBorrowContract,
  CallableBorrowTransfer,
  CallableParameterBorrowContract,
  PlaceProjection,
  ReturnedBorrowOrigin,
  ReturnedTypeMatchingOrigin,
  ScopedCallbackBorrowContract,
} from "./model.js";
import {
  borrowTypeConditionId,
  mergeCallableBorrowContracts,
  normalizeCallableBorrowTransfers,
  projectionsOverlap,
  translateProjectionPath,
} from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import {
  expressionTypeFor,
  resolveBorrowCall,
  resolveBorrowCallTargets,
  type ResolvedBorrowCall,
} from "./call-resolution.js";
import { expressionCanFallThrough } from "./control-flow.js";
import { typeCanCarryReference } from "./reference-bearing.js";

type ParameterOrigin = {
  parameter: number;
  sourceProjections: readonly PlaceProjection[];
  resultProjections: readonly PlaceProjection[];
  borrowed?: true;
  shared?: true;
  returnTypeConditionId?: string;
  accessTypeComparator?: {
    conditionId: string;
    parameter: number;
    sourceProjections: readonly PlaceProjection[];
  };
};
type Flow = ReadonlyMap<string, ParameterOrigin>;
type MutableFlow = Map<string, ParameterOrigin>;
type MutableEnv = Map<SymbolId, MutableFlow>;
type ExitKind = "return" | "break" | "continue";
type ExitEnvironments = Map<ExitKind, MutableEnv[]>;
type ReturnSnapshot = {
  flow: Flow;
  invalidated: Flow;
};

const originKeys = new WeakMap<ParameterOrigin, string>();
const contractEqualityKeys = new WeakMap<CallableBorrowContract, string>();

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
  retained: MutableFlow;
  externalRetained: MutableFlow;
  borrowedRetained: MutableFlow;
  returned: MutableFlow;
  maySuspend: { value: boolean };
  scopedCallbacks: Map<string, ScopedCallbackBorrowContract>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  callResolutionCache: Map<HirExprId, ResolvedBorrowCall>;
  parameterOrigins: Map<SymbolId, number>;
  placeEnvs: Map<MutableEnv, Map<SymbolId, MutableFlow>>;
  localOwnedRoots: Set<SymbolId>;
  terminatedEnvs: Map<MutableEnv, ExitKind>;
  pendingExits: Map<MutableEnv, ExitEnvironments>;
  invalidated: Map<MutableEnv, MutableFlow>;
  returnSnapshots: ReturnSnapshot[];
  transfers: Map<string, CallableBorrowTransfer>;
  decls: DeclTable;
};

const expressionCanCarryReference = (
  exprId: HirExprId,
  ctx: SummaryContext,
): boolean => {
  const type = expressionTypeFor(exprId, ctx);
  if (typeof type !== "number") {
    return true;
  }
  return typeCanCarryReference(type, ctx.typing);
};

const projectionPathKey = (
  projections: readonly PlaceProjection[],
): string =>
  projections
    .map((projection) => {
      switch (projection.kind) {
        case "field":
          return `f${projection.name.length}:${projection.name}`;
        case "tuple":
          return `t${projection.index}`;
        case "index":
          return `i${projection.stable ? 1 : 0}:${projection.constant ?? ""}`;
        case "discriminant":
          return "d";
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
    projectionPathKey(origin.sourceProjections),
    projectionPathKey(origin.resultProjections),
    origin.borrowed === true ? 1 : 0,
    origin.shared === true ? 1 : 0,
    origin.returnTypeConditionId ?? "",
    comparator
      ? `${comparator.conditionId.length}:${comparator.conditionId}:${comparator.parameter}:${projectionPathKey(comparator.sourceProjections)}`
      : "",
  ].join("|");
  originKeys.set(origin, key);
  return key;
};

const emptyFlow = (): MutableFlow => new Map();

const parameterFlow = (parameter: number): MutableFlow => {
  const origin = {
    parameter,
    sourceProjections: [],
    resultProjections: [],
  };
  return new Map([[originKey(origin), origin]]);
};

const addOrigin = (flow: MutableFlow, origin: ParameterOrigin): void => {
  flow.set(originKey(origin), origin);
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
  const clone = new Map(
    Array.from(env, ([symbol, origins]) => [symbol, new Map(origins)] as const),
  );
  ctx.invalidated.set(clone, new Map(ctx.invalidated.get(env) ?? emptyFlow()));
  ctx.placeEnvs.set(
    clone,
    new Map(
      Array.from(ctx.placeEnvs.get(env) ?? [], ([symbol, origins]) => [
        symbol,
        new Map(origins),
      ]),
    ),
  );
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
    target.set(symbol, merged);
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
};

const mergeExitEnvironments = (
  target: ExitEnvironments,
  source: ExitEnvironments | undefined,
): void => {
  source?.forEach((environments, kind) => {
    target.set(kind, [...(target.get(kind) ?? []), ...environments]);
  });
};

const takePendingExits = (
  env: MutableEnv,
  ctx: SummaryContext,
): ExitEnvironments => {
  const exits = ctx.pendingExits.get(env) ?? new Map();
  ctx.pendingExits.delete(env);
  return exits;
};

const retainPendingExits = (
  env: MutableEnv,
  exits: ExitEnvironments,
  ctx: SummaryContext,
): void => {
  if (exits.size > 0) {
    ctx.pendingExits.set(env, exits);
  }
};

const recordExit = (
  env: MutableEnv,
  kind: ExitKind,
  ctx: SummaryContext,
): void => {
  const exits = ctx.pendingExits.get(env) ?? new Map();
  exits.set(kind, [...(exits.get(kind) ?? []), env]);
  ctx.pendingExits.set(env, exits);
  ctx.terminatedEnvs.set(env, kind);
};

const bindPattern = (
  pattern: HirPattern,
  flow: Flow,
  env: MutableEnv,
): void => {
  switch (pattern.kind) {
    case "identifier":
      env.set(pattern.symbol, new Map(flow));
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
): MutableFlow => {
  if (!parameter.returned) {
    return emptyFlow();
  }
  const result = emptyFlow();
  const origins =
    parameter.returnedOrigins && parameter.returnedOrigins.length > 0
      ? parameter.returnedOrigins
      : contractPaths(parameter, "returned").map((source) => ({
          source,
          result: [],
        }));
  origins.forEach((contractOrigin) => {
    const typeCondition = parameter.returnedTypeMatchingOrigins?.find(
      (conditionalOrigin) =>
        JSON.stringify(conditionalOrigin.source) ===
          JSON.stringify(contractOrigin.source) &&
        JSON.stringify(conditionalOrigin.result) ===
          JSON.stringify(contractOrigin.result),
    );
    projectFlow(flow, contractOrigin.source).forEach((origin) =>
      addOrigin(result, {
        ...origin,
        ...(parameter.returnedBorrowedOrigins?.some(
          (borrowedOrigin) =>
            JSON.stringify(borrowedOrigin) === JSON.stringify(contractOrigin),
        )
          ? { borrowed: true }
          : {}),
        ...(parameter.returnedSharedOrigins?.some(
          (sharedOrigin) =>
            JSON.stringify(sharedOrigin) === JSON.stringify(contractOrigin),
        )
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
      }),
    );
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
  ctx: Pick<SummaryContext, "hir" | "symbolTable">,
): { root: SymbolId; projections: readonly PlaceProjection[] } | undefined => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    return { root: expr.symbol, projections: [] };
  }
  if (expr?.exprKind === "field-access") {
    const target = placeOfExpression(expr.target, ctx);
    return target
      ? {
          root: target.root,
          projections: [
            ...target.projections,
            { kind: "field", name: expr.field },
          ],
        }
      : undefined;
  }
  if (expr?.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  if (
    metadata?.intrinsic !== true ||
    (metadata.intrinsicName ?? record.name) !== "~"
  ) {
    return undefined;
  }
  const operand = expr.args.at(-1)?.expr;
  return typeof operand === "number"
    ? placeOfExpression(operand, ctx)
    : undefined;
};

const physicalFlowOfExpression = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
  seen = new Set<SymbolId>(),
): MutableFlow => {
  const place = placeOfExpression(exprId, ctx);
  if (place) {
    const known = ctx.placeEnvs.get(env)?.get(place.root);
    if (known) {
      return projectFlow(known, place.projections);
    }
    const parameter = ctx.parameterOrigins.get(place.root);
    if (parameter !== undefined) {
      return projectFlow(parameterFlow(parameter), place.projections);
    }
    const initializer = ctx.bindingInitializers.get(place.root);
    if (typeof initializer !== "number" || seen.has(place.root)) {
      return emptyFlow();
    }
    seen.add(place.root);
    return projectFlow(
      physicalFlowOfExpression(initializer, env, ctx, seen),
      place.projections,
    );
  }
  const expression = ctx.hir.expressions.get(exprId);
  if (
    expression?.exprKind !== "call" &&
    expression?.exprKind !== "method-call"
  ) {
    return emptyFlow();
  }
  const resolved = resolveBorrowCall(expression, ctx);
  return unionFlows(
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
            physicalFlowOfExpression(actual, env, ctx, new Set(seen)),
            origin.source,
          ),
        );
    }) ?? []),
  );
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
  const mutableDestinations = unionFlows(
    ...(contract.transfers?.map(
      (transfer) => args[transfer.destinationParameter] ?? emptyFlow(),
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
    const flow =
      typeof argExprs[index] === "number"
        ? (args[index] ?? emptyFlow())
        : unionFlows(
            ...(parameter.defaultOrigins ?? []).map(
              (origin) => args[origin] ?? emptyFlow(),
            ),
          );
    if (parameter.access !== "owned") {
      const accessCondition = parameter.accessIfResultTypeDiffers;
      const comparedFlow = accessCondition
        ? projectFlow(
            args[accessCondition.parameter] ?? emptyFlow(),
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
      (parameter.accessPaths ?? [[]]).forEach((path) =>
        projectFlow(flow, path).forEach((origin) =>
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
    }
    if (parameter.retained && !retainedOnlyInLocalDestinations(index)) {
      contractPaths(parameter, "retained").forEach((path) =>
        projectFlow(flow, path).forEach((origin) => {
          if (!mutableDestinationParameters.has(origin.parameter)) {
            retainOrigin(origin, ctx);
          }
        }),
      );
    }
    parameter.externalRetainedPaths?.forEach((path) =>
      projectFlow(flow, path).forEach((origin) =>
        retainOriginExternally(origin, ctx),
      ),
    );
    parameter.borrowedRetainedPaths?.forEach((path) =>
      projectFlow(flow, path).forEach((origin) =>
        addOrigin(ctx.borrowedRetained, origin),
      ),
    );
    if (parameter.returned) {
      returnedFlowForParameter(parameter, flow, callExprId).forEach((origin) =>
        addOrigin(result, origin),
      );
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
      args,
      argExprs,
      env,
      ctx,
    });
    const destination = contract.parameters[transfer.destinationParameter];
    if (!destination) {
      return;
    }
    returnedFlowForParameter(destination, transferred, callExprId).forEach(
      (origin) => addOrigin(result, origin),
    );
  });
  contract.scopedCallbacks?.forEach((callback) => {
    const callbackExpr = argExprs[callback.callbackParameter];
    const callbackOrigins =
      typeof callbackExpr === "number"
        ? callableOriginsOf(callbackExpr, ctx)
        : [];
    callbackOrigins.forEach(({ origin, path }) => {
      const scoped: ScopedCallbackBorrowContract = {
        callbackParameter: origin,
        callbackValueParameter: callback.callbackValueParameter,
        access: callback.access,
        ...(path.length > 0 || callback.callbackPath
          ? {
              callbackPath: [...path, ...(callback.callbackPath ?? [])],
            }
          : {}),
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
  seen = new Set<HirExprId>(),
  requested: readonly PlaceProjection[] = [],
): readonly CallableOrigin[] => {
  if (seen.has(exprId)) {
    return [];
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return [];
  }
  if (expr.exprKind === "field-access") {
    return callableOriginsOf(expr.target, ctx, seen, [
      { kind: "field", name: expr.field },
      ...requested,
    ]);
  }
  if (expr.exprKind === "identifier") {
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? callableOriginsOf(initializer, ctx, seen, requested)
      : typeof ctx.parameterOrigins.get(expr.symbol) === "number"
        ? [
            {
              origin: ctx.parameterOrigins.get(expr.symbol)!,
              path: projectionPathNames(requested),
            },
          ]
        : [];
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return [
      ...expr.branches.flatMap((branch) =>
        callableOriginsOf(branch.value, ctx, new Set(seen), requested),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? callableOriginsOf(expr.defaultBranch, ctx, new Set(seen), requested)
        : []),
    ];
  }
  if (expr.exprKind === "match") {
    return expr.arms.flatMap((arm) =>
      callableOriginsOf(arm.value, ctx, new Set(seen), requested),
    );
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return callableOriginsOf(expr.value, ctx, seen, requested);
  }
  if (expr.exprKind === "object-literal") {
    const [projection, ...remaining] = requested;
    if (projection?.kind !== "field") {
      return [];
    }
    const entry = expr.entries.find(
      (candidate) =>
        candidate.kind === "field" && candidate.name === projection.name,
    );
    return entry
      ? callableOriginsOf(entry.value, ctx, new Set(seen), remaining)
      : [];
  }
  if (expr.exprKind === "tuple") {
    const [projection, ...remaining] = requested;
    if (projection?.kind !== "tuple") {
      return [];
    }
    const element = expr.elements[projection.index];
    return typeof element === "number"
      ? callableOriginsOf(element, ctx, new Set(seen), remaining)
      : [];
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    const resolved = resolveBorrowCall(expr, ctx);
    return (
      resolved.contract?.parameters.flatMap((parameter, index) => {
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
        return origins.flatMap((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          return translated
            ? callableOriginsOf(actual, ctx, new Set(seen), translated)
            : [];
        });
      }) ?? []
    );
  }
  return [];
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
        retainedPaths: _retainedPaths,
        externalRetainedPaths: _externalRetainedPaths,
        borrowedRetainedPaths: _borrowedRetainedPaths,
        returnedPaths: _returnedPaths,
        returnedOrigins: _returnedOrigins,
        returnedBorrowedOrigins: _returnedBorrowedOrigins,
        returnedSharedOrigins: _returnedSharedOrigins,
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

const evaluateBlock = (
  expr: HirBlockExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const pendingExits: ExitEnvironments = new Map();
  const collectPendingExits = (): void => {
    mergeExitEnvironments(pendingExits, takePendingExits(env, ctx));
  };
  const finish = (flow: MutableFlow): MutableFlow => {
    collectPendingExits();
    retainPendingExits(env, pendingExits, ctx);
    return flow;
  };
  for (const statementId of expr.statements) {
    const statement = ctx.hir.statements.get(statementId);
    if (!statement) {
      continue;
    }
    if (statement.kind === "let") {
      const flow = evaluateExpression(statement.initializer, env, ctx);
      collectPendingExits();
      const locallyOwnedSymbols =
        statement.pattern.kind === "identifier" &&
        physicalFlowOfExpression(statement.initializer, env, ctx).size === 0
          ? new Set([statement.pattern.symbol])
          : new Set<SymbolId>();
      bindPattern(statement.pattern, flow, env);
      mutablePatternSymbols(statement.pattern).forEach((symbol) =>
        ctx.placeEnvs
          .get(env)
          ?.set(
            symbol,
            locallyOwnedSymbols.has(symbol)
              ? emptyFlow()
              : new Map(env.get(symbol) ?? emptyFlow()),
          ),
      );
      patternSymbols(statement.pattern).forEach((symbol) =>
        ctx.bindingInitializers.set(symbol, statement.initializer),
      );
      locallyOwnedSymbols.forEach((symbol) => ctx.localOwnedRoots.add(symbol));
      if (ctx.terminatedEnvs.has(env)) {
        return finish(emptyFlow());
      }
      continue;
    }
    if (statement.kind === "return") {
      const flow =
        typeof statement.value === "number"
          ? evaluateExpression(statement.value, env, ctx)
          : emptyFlow();
      const invalidated = new Map(ctx.invalidated.get(env) ?? emptyFlow());
      ctx.returnSnapshots.push({
        flow: new Map(flow),
        invalidated,
      });
      flow.forEach((origin) => addOrigin(ctx.returned, origin));
      collectPendingExits();
      recordExit(env, "return", ctx);
      return finish(emptyFlow());
    }
    evaluateExpression(statement.expr, env, ctx);
    collectPendingExits();
    if (ctx.terminatedEnvs.has(env)) {
      return finish(emptyFlow());
    }
    if (!expressionCanFallThrough(statement.expr, ctx.hir)) {
      return finish(emptyFlow());
    }
  }
  const flow =
    typeof expr.value === "number"
      ? evaluateExpression(expr.value, env, ctx)
      : emptyFlow();
  return finish(flow);
};

const evaluateBranches = ({
  branches,
  defaultBranch,
  env,
  ctx,
}: {
  branches: readonly { condition: HirExprId; value: HirExprId }[];
  defaultBranch?: HirExprId;
  env: MutableEnv;
  ctx: SummaryContext;
}): MutableFlow => {
  const branchEnvs: MutableEnv[] = [];
  const branchExits: ExitEnvironments = new Map();
  const branchFlows = branches.map((branch) => {
    evaluateExpression(branch.condition, env, ctx);
    const branchEnv = cloneEnv(env, ctx);
    const flow = evaluateExpression(branch.value, branchEnv, ctx);
    const exit = ctx.terminatedEnvs.get(branchEnv);
    const exits = takePendingExits(branchEnv, ctx);
    if (exit && !exits.has(exit)) {
      exits.set(exit, [branchEnv]);
    }
    mergeExitEnvironments(branchExits, exits);
    if (exit) {
      ctx.terminatedEnvs.delete(branchEnv);
    } else {
      branchEnvs.push(branchEnv);
    }
    return flow;
  });
  if (typeof defaultBranch === "number") {
    const branchEnv = cloneEnv(env, ctx);
    const flow = evaluateExpression(defaultBranch, branchEnv, ctx);
    const exit = ctx.terminatedEnvs.get(branchEnv);
    const exits = takePendingExits(branchEnv, ctx);
    if (exit && !exits.has(exit)) {
      exits.set(exit, [branchEnv]);
    }
    mergeExitEnvironments(branchExits, exits);
    if (exit) {
      ctx.terminatedEnvs.delete(branchEnv);
    } else {
      branchEnvs.push(branchEnv);
    }
    branchFlows.push(flow);
  } else {
    branchEnvs.push(cloneEnv(env, ctx));
  }
  retainPendingExits(env, branchExits, ctx);
  if (branchEnvs.length === 0) {
    ctx.terminatedEnvs.set(
      env,
      branchExits.has("break")
        ? "break"
        : branchExits.has("continue")
          ? "continue"
          : "return",
    );
    return emptyFlow();
  }
  mergeEnvs(env, branchEnvs, ctx);
  return unionFlows(...branchFlows);
};

const evaluateMatch = (
  expr: HirMatchExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const discriminant = evaluateExpression(expr.discriminant, env, ctx);
  recordAccess(projectFlow(discriminant, [{ kind: "discriminant" }]), ctx);
  const armEnvs: MutableEnv[] = [];
  const armExits: ExitEnvironments = new Map();
  const flows = expr.arms.map((arm) => {
    const armEnv = cloneEnv(env, ctx);
    bindPattern(arm.pattern, discriminant, armEnv);
    if (typeof arm.guard === "number") {
      evaluateExpression(arm.guard, armEnv, ctx);
    }
    const flow = evaluateExpression(arm.value, armEnv, ctx);
    const exit = ctx.terminatedEnvs.get(armEnv);
    const exits = takePendingExits(armEnv, ctx);
    if (exit && !exits.has(exit)) {
      exits.set(exit, [armEnv]);
    }
    mergeExitEnvironments(armExits, exits);
    if (exit) {
      ctx.terminatedEnvs.delete(armEnv);
    } else {
      armEnvs.push(armEnv);
    }
    return flow;
  });
  retainPendingExits(env, armExits, ctx);
  if (armEnvs.length === 0) {
    ctx.terminatedEnvs.set(
      env,
      armExits.has("break")
        ? "break"
        : armExits.has("continue")
          ? "continue"
          : "return",
    );
    return emptyFlow();
  }
  mergeEnvs(env, armEnvs, ctx);
  return unionFlows(...flows);
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

const evaluateEffectHandler = (
  expr: HirEffectHandlerExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const flows = [evaluateExpression(expr.body, env, ctx)];
  expr.handlers.forEach((handler) => {
    const handlerEnv = cloneEnv(env, ctx);
    handler.parameters.forEach((parameter) =>
      handlerEnv.set(parameter.symbol, emptyFlow()),
    );
    flows.push(evaluateExpression(handler.body, handlerEnv, ctx));
  });
  if (typeof expr.finallyBranch === "number") {
    flows.push(evaluateExpression(expr.finallyBranch, env, ctx));
  }
  return unionFlows(...flows);
};

const evaluateExpression = (
  exprId: HirExprId,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return emptyFlow();
  }
  switch (expr.exprKind) {
    case "literal":
    case "overload-set":
      return emptyFlow();
    case "identifier": {
      const flow = new Map(env.get(expr.symbol) ?? emptyFlow());
      if (expressionCanCarryReference(expr.id, ctx)) {
        return flow;
      }
      recordAccess(flow, ctx);
      return emptyFlow();
    }
    case "field-access": {
      const target = evaluateExpression(expr.target, env, ctx);
      const projected = projectFlow(target, [
        { kind: "field", name: expr.field },
      ]);
      recordAccess(projected, ctx);
      return expressionCanCarryReference(expr.id, ctx)
        ? projected
        : emptyFlow();
    }
    case "tuple":
      return unionFlows(
        ...expr.elements.map((element, index) => {
          const flow = evaluateExpression(element, env, ctx);
          return expressionCanCarryReference(element, ctx)
            ? storeFlowAt(flow, { kind: "tuple", index })
            : emptyFlow();
        }),
      );
    case "object-literal":
      return unionFlows(
        ...expr.entries.map((entry) => {
          const flow = evaluateExpression(entry.value, env, ctx);
          if (!expressionCanCarryReference(entry.value, ctx)) {
            return emptyFlow();
          }
          return entry.kind === "field"
            ? storeFlowAt(flow, { kind: "field", name: entry.name })
            : flow;
        }),
      );
    case "lambda":
      return evaluateLambda(expr, env, ctx);
    case "block":
      return evaluateBlock(expr, env, ctx);
    case "if":
    case "cond":
      return evaluateBranches({
        branches: expr.branches,
        defaultBranch: expr.defaultBranch,
        env,
        ctx,
      });
    case "match":
      return evaluateMatch(expr, env, ctx);
    case "loop": {
      const loopEnv = cloneEnv(env, ctx);
      const flow = evaluateExpression(expr.body, loopEnv, ctx);
      const terminated = ctx.terminatedEnvs.has(loopEnv);
      const exits = takePendingExits(loopEnv, ctx);
      const breakEnvs = exits.get("break") ?? [];
      const backEdgeEnvs = [
        ...(exits.get("continue") ?? []),
        ...(!terminated ? [loopEnv] : []),
      ];
      const returnEnvs = exits.get("return") ?? [];
      ctx.terminatedEnvs.delete(loopEnv);
      if (breakEnvs.length > 0 || backEdgeEnvs.length > 0) {
        mergeEnvs(env, [...breakEnvs, ...backEdgeEnvs], ctx);
      } else if (returnEnvs.length > 0) {
        ctx.terminatedEnvs.set(env, "return");
      }
      if (returnEnvs.length > 0) {
        retainPendingExits(env, new Map([["return", returnEnvs]]), ctx);
      }
      return flow;
    }
    case "while": {
      evaluateExpression(expr.condition, env, ctx);
      const conditionExits = takePendingExits(env, ctx);
      const loopEnv = cloneEnv(env, ctx);
      evaluateExpression(expr.body, loopEnv, ctx);
      const terminated = ctx.terminatedEnvs.has(loopEnv);
      const exits = takePendingExits(loopEnv, ctx);
      ctx.terminatedEnvs.delete(loopEnv);
      mergeEnvs(
        env,
        [
          env,
          ...(exits.get("break") ?? []),
          ...(exits.get("continue") ?? []),
          ...(!terminated ? [loopEnv] : []),
        ],
        ctx,
      );
      const propagated: ExitEnvironments = new Map();
      mergeExitEnvironments(propagated, conditionExits);
      const returnEnvs = exits.get("return");
      if (returnEnvs) {
        propagated.set("return", returnEnvs);
      }
      retainPendingExits(env, propagated, ctx);
      return emptyFlow();
    }
    case "break": {
      const flow =
        typeof expr.value === "number"
          ? evaluateExpression(expr.value, env, ctx)
          : emptyFlow();
      recordExit(env, "break", ctx);
      return flow;
    }
    case "continue":
      recordExit(env, "continue", ctx);
      return emptyFlow();
    case "effect-handler":
      return evaluateEffectHandler(expr, env, ctx);
    case "assign": {
      const value = evaluateExpression(expr.value, env, ctx);
      if (expr.pattern) {
        bindPattern(expr.pattern, value, env);
        return emptyFlow();
      }
      if (typeof expr.target !== "number") {
        return emptyFlow();
      }
      const targetExpr = ctx.hir.expressions.get(expr.target);
      if (targetExpr?.exprKind === "identifier") {
        const targetRecord = ctx.symbolTable.getSymbol(targetExpr.symbol);
        if (ctx.symbolTable.getScope(targetRecord.scope).kind === "module") {
          value.forEach((origin) => retainOriginExternally(origin, ctx));
          return emptyFlow();
        }
        const placeEnv = ctx.placeEnvs.get(env);
        const physicalTarget = placeEnv?.get(targetExpr.symbol) ?? emptyFlow();
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
      evaluateExpression(expr.target, env, ctx);
      const targetPlace = placeOfExpression(expr.target, ctx);
      if (!targetPlace) {
        return emptyFlow();
      }
      const physicalTarget = physicalFlowOfExpression(expr.target, env, ctx);
      const rootFlow = env.get(targetPlace.root) ?? emptyFlow();
      const storedValue = storeFlowAtPath(value, targetPlace.projections);
      env.set(targetPlace.root, unionFlows(rootFlow, storedValue));
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
      const callee = evaluateExpression(expr.callee, env, ctx);
      recordAccess(callee, ctx);
      const evaluated = new Map(
        expr.args.map((argument) => [
          argument.expr,
          evaluateExpression(argument.expr, env, ctx),
        ]),
      );
      const resolved = resolveBorrowCall(expr, ctx);
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
      const evaluated = new Map<HirExprId, MutableFlow>([
        [expr.target, evaluateExpression(expr.target, env, ctx)],
        ...expr.args.map(
          (argument) =>
            [
              argument.expr,
              evaluateExpression(argument.expr, env, ctx),
            ] as const,
        ),
      ]);
      const resolved = resolveBorrowCall(expr, ctx);
      const args = resolved.arguments.map((argument) =>
        typeof argument === "number"
          ? (evaluated.get(argument) ?? emptyFlow())
          : emptyFlow(),
      );
      if (
        resolved.targets.some((target) =>
          targetMaySuspend(target, resolved, ctx),
        )
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
    ...(access === "shared" ? { accessPaths: [] } : {}),
    retained: false,
    returned: false,
  };
};

const initialFunctionContract = ({
  functionItem,
  typing,
  symbolTable,
  moduleId,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
}): CallableBorrowContract => {
  const scopedCallbacks = declaredScopedCallbacks({
    functionItem,
    typing,
    symbolTable,
    moduleId,
  });
  return {
    parameters: functionItem.parameters.map((_parameter, index) =>
      parameterContract(functionItem, index, typing),
    ),
    maySuspend: false,
    ...(scopedCallbacks.length > 0 ? { scopedCallbacks } : {}),
  };
};

const functionNeedsBorrowSummary = (
  functionItem: HirFunction,
  contract: CallableBorrowContract,
  typing: TypingResult,
): boolean => {
  if (contract.parameters.some((parameter) => parameter.access !== "owned")) {
    return true;
  }
  const signature = typing.functions.getSignature(functionItem.symbol);
  return (
    signature === undefined || !typing.effects.isEmpty(signature.effectRow)
  );
};

const declaredScopedCallbacks = ({
  functionItem,
  typing,
  symbolTable,
  moduleId,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
}): readonly ScopedCallbackBorrowContract[] => {
  const owner = typing.memberMetadata.get(functionItem.symbol)?.owner;
  if (typeof owner !== "number") {
    return [];
  }
  const method = symbolTable.getSymbol(functionItem.symbol).name;
  if (
    moduleId === "std::array" &&
    symbolTable.getSymbol(owner).name === "Array" &&
    method === "sort"
  ) {
    return [0, 1].map((callbackValueParameter) => ({
      callbackParameter: 1,
      callbackValueParameter,
      access: "shared",
    }));
  }
  const ownerMetadata = symbolTable.getSymbol(owner).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  if (ownerMetadata?.intrinsicType !== STD_INTRINSIC_TYPE.sharedCell) {
    return [];
  }
  if (!["with", "with_mut", "try_with", "try_with_mut"].includes(method)) {
    return [];
  }
  return [
    {
      callbackParameter: 1,
      callbackValueParameter: 0,
      access: method.includes("mut") ? "mutable" : "shared",
    },
  ];
};

const originsForParameter = (
  flow: Flow,
  parameter: number,
): readonly ParameterOrigin[] =>
  Array.from(flow.values()).filter((origin) => origin.parameter === parameter);

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
): readonly (readonly PlaceProjection[])[] =>
  Array.from(
    new Map(
      originsForParameter(flow, parameter).map((origin) => [
        JSON.stringify(origin.sourceProjections),
        origin.sourceProjections,
      ]),
    ).values(),
  );

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
    ]);
    groups.set(key, [...(groups.get(key) ?? []), origin]);
  });
  const entries = Array.from(groups.values()).map((group) => {
    return {
      origin: {
        source: group[0]!.sourceProjections,
        result: group[0]!.resultProjections,
      },
      conditionId: group.every(
        (origin) => origin.returnTypeConditionId !== undefined,
      )
        ? borrowTypeConditionId({
            parameter,
            sourcePath: group[0]!.sourceProjections,
            resultPath: group[0]!.resultProjections,
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
      JSON.stringify(origin.resultProjections),
      origin.resultProjections,
    ]),
  );
  if (resultPaths.size !== 1) {
    return undefined;
  }
  return {
    conditionId: borrowTypeConditionId({
      parameter: comparator.parameter,
      sourcePath: comparator.sourceProjections,
      resultPath: Array.from(resultPaths.values())[0]!,
    }),
    parameter: comparator.parameter,
    sourcePath: comparator.sourceProjections,
    resultPath: Array.from(resultPaths.values())[0]!,
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
          candidateIndex !== index &&
          candidate.length <= path.length &&
          candidate.every(
            (projection, projectionIndex) =>
              JSON.stringify(projection) ===
              JSON.stringify(path[projectionIndex]),
          ),
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
  const origins = Array.from(
    new Map(
      originsForParameter(returned, parameter).map((origin) => [
        JSON.stringify([origin.sourceProjections, origin.resultProjections]),
        origin,
      ]),
    ).values(),
  );
  return origins.filter((origin) =>
    returnSnapshots.every((snapshot) => {
      const matching = originsForParameter(snapshot.flow, parameter).filter(
        (candidate) =>
          JSON.stringify(candidate.sourceProjections) ===
            JSON.stringify(origin.sourceProjections) &&
          JSON.stringify(candidate.resultProjections) ===
            JSON.stringify(origin.resultProjections),
      );
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
  const accessed = emptyFlow();
  const retained = emptyFlow();
  const externalRetained = emptyFlow();
  const borrowedRetained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map(
    declaredScopedCallbacks({
      functionItem,
      typing,
      symbolTable,
      moduleId,
    }).map((callback) => [
      `${callback.callbackParameter}:${callback.callbackValueParameter}:`,
      callback,
    ]),
  );
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const placeEnvs = new Map<MutableEnv, Map<SymbolId, MutableFlow>>();
  const localOwnedRoots = new Set<SymbolId>();
  const terminatedEnvs = new Map<MutableEnv, ExitKind>();
  const pendingExits = new Map<MutableEnv, ExitEnvironments>();
  const invalidated = new Map<MutableEnv, MutableFlow>();
  const returnSnapshots: ReturnSnapshot[] = [];
  const transfers = new Map<string, CallableBorrowTransfer>();
  const defaultOrigins = new Map<number, readonly number[]>();
  const env: MutableEnv = new Map();
  invalidated.set(env, emptyFlow());
  placeEnvs.set(env, new Map());
  functionItem.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlow(index), env);
    patternSymbols(parameter.pattern).forEach((symbol) =>
      parameterOrigins.set(symbol, index),
    );
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
    retained,
    externalRetained,
    borrowedRetained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    callResolutionCache: new Map(),
    parameterOrigins,
    placeEnvs,
    localOwnedRoots,
    terminatedEnvs,
    pendingExits,
    invalidated,
    returnSnapshots,
    transfers,
    decls,
  };
  functionItem.parameters.forEach((parameter, index) => {
    if (typeof parameter.defaultValue !== "number") {
      return;
    }
    const defaultFlow = evaluateExpression(parameter.defaultValue, env, ctx);
    defaultOrigins.set(
      index,
      Array.from(
        new Set(Array.from(defaultFlow.values(), (origin) => origin.parameter)),
      ),
    );
    const suppliedFlow = unionFlows(parameterFlow(index), defaultFlow);
    bindPattern(parameter.pattern, suppliedFlow, env);
  });
  const tail = evaluateExpression(functionItem.body, env, ctx);
  if (expressionCanFallThrough(functionItem.body, hir)) {
    const tailInvalidations = new Map(invalidated.get(env) ?? emptyFlow());
    returnSnapshots.push({
      flow: new Map(tail),
      invalidated: tailInvalidations,
    });
    tail.forEach((origin) => addOrigin(returned, origin));
  }
  const definitelyInvalidated = intersectFlows(
    returnSnapshots.map((snapshot) => snapshot.invalidated),
  );
  const escapingRetained = escapingRetainedOrigins({
    retained,
    returned,
    transfers: transfers.values(),
  });
  return {
    parameters: functionItem.parameters.map((_parameter, index) => {
      const directlyRetainedPaths = pathsForParameter(escapingRetained, index);
      const externalRetainedPaths = pathsForParameter(externalRetained, index);
      const retainedPaths = mergePaths(
        directlyRetainedPaths,
        externalRetainedPaths,
      );
      const borrowedRetainedPaths = pathsForParameter(borrowedRetained, index);
      const returnedContractOrigins = returnedContractOriginsForParameter(
        returned,
        index,
      );
      const returnedOrigins = returnedContractOrigins.origins;
      const returnedBorrowedOrigins = originsForParameter(returned, index)
        .filter((origin) => origin.borrowed === true)
        .map((origin) => ({
          source: origin.sourceProjections,
          result: origin.resultProjections,
        }));
      const invalidatedPaths = pathsForParameter(definitelyInvalidated, index);
      const returnedSharedOrigins = returnedSharedOriginsForParameter({
        returned,
        returnSnapshots,
        parameter: index,
      }).map((origin) => ({
        source: origin.sourceProjections,
        result: origin.resultProjections,
      }));
      const access =
        baseContracts.get(functionItem.symbol)?.parameters[index]?.access ??
        parameterContract(functionItem, index, typing).access;
      const accessPaths = minimizeProjectionPaths(
        pathsForParameter(accessed, index),
      );
      const accessCondition = accessConditionForParameter(
        accessed,
        returned,
        index,
      );
      const returnedTypeMatchingOrigins = returnedContractOrigins.typeMatching;
      return {
        access,
        ...(access === "shared" ? { accessPaths } : {}),
        ...(accessCondition
          ? { accessIfResultTypeDiffers: accessCondition }
          : {}),
        retained: retainedPaths.length > 0,
        returned: returnedOrigins.length > 0,
        ...(returnedTypeMatchingOrigins.length > 0
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(externalRetainedPaths.length > 0 ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths.length > 0 ? { borrowedRetainedPaths } : {}),
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
        ...(returnedBorrowedOrigins.length > 0
          ? { returnedBorrowedOrigins }
          : {}),
        ...(returnedSharedOrigins.length > 0 ? { returnedSharedOrigins } : {}),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
        ...(defaultOrigins.get(index)?.length
          ? { defaultOrigins: defaultOrigins.get(index) }
          : {}),
      };
    }),
    maySuspend: maySuspend.value,
    ...(transfers.size > 0
      ? { transfers: Array.from(transfers.values()) }
      : {}),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
};

const contractEqualityKey = (contract: CallableBorrowContract): string => {
  const cached = contractEqualityKeys.get(contract);
  if (cached) {
    return cached;
  }
  const key = JSON.stringify([
    contract.parameters.map((parameter) => [
      parameter.access,
      parameter.accessPaths ?? [],
      parameter.retained,
      parameter.returned,
      parameter.returnedTypeMatchingOrigins ?? [],
      parameter.accessIfResultTypeDiffers ?? null,
      parameter.retainedPaths ?? [],
      parameter.externalRetainedPaths ?? [],
      parameter.borrowedRetainedPaths ?? [],
      parameter.returnedPaths ?? [],
      parameter.returnedOrigins ?? [],
      parameter.returnedBorrowedOrigins ?? [],
      parameter.returnedSharedOrigins ?? [],
      parameter.invalidatedPaths ?? [],
      parameter.defaultOrigins ?? [],
    ]),
    contract.maySuspend,
    contract.transfers ?? [],
    contract.scopedCallbacks ?? [],
  ]);
  contractEqualityKeys.set(contract, key);
  return key;
};

const contractsEqual = (
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
    return [{ source: [], result: [] }];
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
  const { transfers: _transfers, ...baseContract } = contract;
  const transfers = normalizeCallableBorrowTransfers(contract.transfers);
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
            JSON.stringify(origin.result) === JSON.stringify(condition.result),
        ),
      );
    },
  );
  return {
    ...baseContract,
    parameters: contract.parameters.map((parameter, index) => {
      const {
        accessPaths: _accessPaths,
        invalidatedPaths: _invalidatedPaths,
        externalRetainedPaths: _externalRetainedPaths,
        borrowedRetainedPaths: _borrowedRetainedPaths,
        returnedBorrowedOrigins: _returnedBorrowedOrigins,
        returnedSharedOrigins: _returnedSharedOrigins,
        returnedTypeMatchingOrigins: _returnedConditions,
        accessIfResultTypeDiffers: _accessCondition,
        ...baseParameter
      } = parameter;
      const accessPaths =
        parameter.accessPaths === undefined
          ? undefined
          : minimizeProjectionPaths(
              projectionPathsOrBroad(parameter.accessPaths) ?? [],
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
      const returnedBorrowedOrigins = returnedOriginsOrBroad(
        parameter.returnedBorrowedOrigins,
      );
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
      return {
        ...baseParameter,
        ...(accessPaths !== undefined ? { accessPaths } : {}),
        ...(retainedPaths ? { retainedPaths } : {}),
        ...(externalRetainedPaths ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths ? { borrowedRetainedPaths } : {}),
        ...(returnedPaths ? { returnedPaths } : {}),
        ...(returnedOrigins ? { returnedOrigins } : {}),
        ...(returnedBorrowedOrigins ? { returnedBorrowedOrigins } : {}),
        ...(returnedSharedOrigins ? { returnedSharedOrigins } : {}),
        ...(returnedTypeMatchingOrigins?.length
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(validAccessCondition
          ? { accessIfResultTypeDiffers: validAccessCondition }
          : {}),
        ...(invalidatedPaths ? { invalidatedPaths } : {}),
      };
    }),
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

const resetDerivedContractFacts = (
  contract: CallableBorrowContract,
): CallableBorrowContract => ({
  ...contract,
  parameters: contract.parameters.map((parameter) => {
    const {
      accessPaths: _accessPaths,
      retainedPaths: _retainedPaths,
      externalRetainedPaths: _externalRetainedPaths,
      borrowedRetainedPaths: _borrowedRetainedPaths,
      returnedPaths: _returnedPaths,
      returnedOrigins: _returnedOrigins,
      returnedBorrowedOrigins: _returnedBorrowedOrigins,
      returnedSharedOrigins: _returnedSharedOrigins,
      returnedTypeMatchingOrigins: _returnedConditions,
      accessIfResultTypeDiffers: _accessCondition,
      ...base
    } = parameter;
    return {
      ...base,
      ...(parameter.access === "shared" ? { accessPaths: [] } : {}),
      retained: false,
      returned: false,
    };
  }),
});

const stripReturnedSharedOrigins = (
  contract: CallableBorrowContract,
): CallableBorrowContract => ({
  ...contract,
  parameters: contract.parameters.map((parameter) => {
    const {
      returnedSharedOrigins: _returnedSharedOrigins,
      ...withoutSharedOrigins
    } = parameter;
    return withoutSharedOrigins;
  }),
});

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

const mustContractSignature = (
  contract: CallableBorrowContract,
): string =>
  JSON.stringify(
    {
      invalidatedPaths: contract.parameters.map(
        (parameter) => parameter.invalidatedPaths ?? [],
      ),
      transfers: contract.transfers ?? [],
    },
  );

const mustContractSignatures = (
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>,
): ReadonlyMap<SymbolId, string> =>
  new Map(
    Array.from(contracts, ([symbol, contract]) => [
      symbol,
      mustContractSignature(contract),
    ]),
  );

const transitiveCallersOf = ({
  symbols,
  callers,
}: {
  symbols: ReadonlySet<SymbolId>;
  callers: ReadonlyMap<SymbolId, readonly HirFunction[]>;
}): ReadonlySet<SymbolId> => {
  const affected = new Set(symbols);
  const worklist = [...symbols];
  let cursor = 0;
  while (cursor < worklist.length) {
    const symbol = worklist[cursor++]!;
    (callers.get(symbol) ?? []).forEach((caller) => {
      if (affected.has(caller.symbol)) {
        return;
      }
      affected.add(caller.symbol);
      worklist.push(caller.symbol);
    });
  }
  return affected;
};

export const computeCallableBorrowContracts = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
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
}): Map<SymbolId, CallableBorrowContract> => {
  const functions = Array.from(hir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  let contracts = new Map<SymbolId, CallableBorrowContract>(
    functions.map((functionItem) => [
      functionItem.symbol,
      initialFunctionContract({
        functionItem,
        typing,
        symbolTable,
        moduleId,
      }),
    ]),
  );
  const summaryFunctions = functions.filter((functionItem) =>
    functionNeedsBorrowSummary(
      functionItem,
      contracts.get(functionItem.symbol)!,
      typing,
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.summary.functions",
    summaryFunctions.length,
  );
  const callers = localCallersOf({
    functions: summaryFunctions,
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    decls,
  });
  const orderedSummaryFunctions = dependencyOrderedFunctions(
    summaryFunctions,
    callers,
  );
  const summarySymbols = new Set(
    summaryFunctions.map((functionItem) => functionItem.symbol),
  );
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
  const finalCandidates = new Map<SymbolId, CallableBorrowContract>();
  const converge = (
    seeds: readonly HirFunction[] = orderedSummaryFunctions,
  ): void => {
    const worklist = [...seeds];
    const queued = new Set(
      seeds.map((functionItem) => functionItem.symbol),
    );
    let cursor = 0;
    while (cursor < worklist.length) {
      const functionItem = worklist[cursor++]!;
      queued.delete(functionItem.symbol);
      const previous = contracts.get(functionItem.symbol)!;
      const candidate = summarizeFunction({
        functionItem,
        baseContracts: contracts,
        hir,
        typing,
        symbolTable,
        moduleId,
        imports: importMap,
        dependencies,
        decls,
      });
      finalCandidates.set(functionItem.symbol, candidate);
      if (contractsEqual(previous, candidate)) {
        incrementCompilerPerfCounter("borrowing.summary.unchangedCandidates");
        continue;
      }
      const joined = joinCallableBorrowContracts({ previous, candidate });
      if (contractsEqual(previous, joined)) {
        incrementCompilerPerfCounter("borrowing.summary.unchangedJoins");
        continue;
      }
      contracts.set(functionItem.symbol, joined);
      (callers.get(functionItem.symbol) ?? []).forEach((dependent) => {
        if (queued.has(dependent.symbol)) {
          return;
        }
        queued.add(dependent.symbol);
        worklist.push(dependent);
      });
    }
  };
  let mustSignatures = mustContractSignatures(contracts);
  let convergenceSeeds = orderedSummaryFunctions;
  while (true) {
    converge(convergenceSeeds);
    const nextMustSignatures = mustContractSignatures(contracts);
    const changedMustSymbols = new Set(
      Array.from(nextMustSignatures.keys()).filter(
        (symbol) => nextMustSignatures.get(symbol) !== mustSignatures.get(symbol),
      ),
    );
    if (changedMustSymbols.size === 0) {
      break;
    }
    mustSignatures = nextMustSignatures;
    const affectedSymbols = transitiveCallersOf({
      symbols: changedMustSymbols,
      callers,
    });
    contracts = new Map(
      Array.from(contracts, ([symbol, contract]) => [
        symbol,
        affectedSymbols.has(symbol)
          ? resetDerivedContractFacts(contract)
          : contract,
      ]),
    );
    convergenceSeeds = orderedSummaryFunctions.filter((functionItem) =>
      affectedSymbols.has(functionItem.symbol),
    );
  }
  contracts = new Map(
    Array.from(contracts, ([symbol, contract]) => [
      symbol,
      stripReturnedSharedOrigins(contract),
    ]),
  );
  const sharedWorklist = orderedSummaryFunctions.filter((functionItem) =>
    contracts
      .get(functionItem.symbol)
      ?.parameters.some((parameter) => parameter.returned),
  );
  const sharedQueued = new Set(
    sharedWorklist.map((functionItem) => functionItem.symbol),
  );
  const sharedContractsChanged = new Set<SymbolId>();
  let sharedCursor = 0;
  while (sharedCursor < sharedWorklist.length) {
    const functionItem = sharedWorklist[sharedCursor++]!;
    sharedQueued.delete(functionItem.symbol);
    const previous = contracts.get(functionItem.symbol)!;
    const cachedCandidate =
      Array.from(
        localSummaryDependencies.get(functionItem.symbol) ?? [],
      ).some((dependency) => sharedContractsChanged.has(dependency))
        ? undefined
        : finalCandidates.get(functionItem.symbol);
    const candidate =
      cachedCandidate ??
      summarizeFunction({
        functionItem,
        baseContracts: contracts,
        hir,
        typing,
        symbolTable,
        moduleId,
        imports: importMap,
        dependencies,
        decls,
      });
    const next = withReturnedSharedOrigins({
      contract: previous,
      candidate,
    });
    if (contractsEqual(previous, next)) {
      continue;
    }
    contracts.set(functionItem.symbol, next);
    sharedContractsChanged.add(functionItem.symbol);
    (callers.get(functionItem.symbol) ?? []).forEach((dependent) => {
      if (sharedQueued.has(dependent.symbol)) {
        return;
      }
      sharedQueued.add(dependent.symbol);
      sharedWorklist.push(dependent);
    });
  }
  return contracts;
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

const dependencyOrderedFunctions = (
  functions: readonly HirFunction[],
  callers: ReadonlyMap<SymbolId, readonly HirFunction[]>,
): readonly HirFunction[] => {
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
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
}: {
  functions: readonly HirFunction[];
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
}): ReadonlyMap<SymbolId, readonly HirFunction[]> => {
  const byTarget = new Map<SymbolId, HirFunction[]>();
  const context = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    contracts: new Map<SymbolId, CallableBorrowContract>(),
    bindingInitializers: new Map<SymbolId, HirExprId>(),
    borrowIndexMode: "symbolic" as const,
    decls,
  };
  functions.forEach((caller) => {
    const visit = (_exprId: HirExprId, expr: HirExpression): void => {
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return;
      }
      resolveBorrowCallTargets(expr, context).forEach((target) => {
        if (target.moduleId !== moduleId) {
          return;
        }
        const current = byTarget.get(target.symbol) ?? [];
        if (!current.some((entry) => entry.symbol === caller.symbol)) {
          current.push(caller);
          byTarget.set(target.symbol, current);
        }
      });
    };
    caller.parameters.forEach((parameter) => {
      if (typeof parameter.defaultValue === "number") {
        walkExpression({
          exprId: parameter.defaultValue,
          hir,
          onEnterExpression: visit,
          options: { skipLambdas: true },
        });
      }
    });
    walkExpression({
      exprId: caller.body,
      hir,
      onEnterExpression: visit,
      options: { skipLambdas: true },
    });
  });
  return byTarget;
};

export const summarizeLambdaBorrowing = ({
  lambda,
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
  const retained = emptyFlow();
  const externalRetained = emptyFlow();
  const borrowedRetained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map<string, ScopedCallbackBorrowContract>();
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const placeEnvs = new Map<MutableEnv, Map<SymbolId, MutableFlow>>();
  const localOwnedRoots = new Set<SymbolId>();
  const terminatedEnvs = new Map<MutableEnv, ExitKind>();
  const pendingExits = new Map<MutableEnv, ExitEnvironments>();
  const invalidated = new Map<MutableEnv, MutableFlow>();
  const returnSnapshots: ReturnSnapshot[] = [];
  const transfers = new Map<string, CallableBorrowTransfer>();
  const env: MutableEnv = new Map();
  invalidated.set(env, emptyFlow());
  placeEnvs.set(env, new Map());
  lambda.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlow(index), env);
    patternSymbols(parameter.pattern).forEach((symbol) =>
      parameterOrigins.set(symbol, index),
    );
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
    retained,
    externalRetained,
    borrowedRetained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    callResolutionCache: new Map(),
    parameterOrigins,
    placeEnvs,
    localOwnedRoots,
    terminatedEnvs,
    pendingExits,
    invalidated,
    returnSnapshots,
    transfers,
    decls,
  };
  const tail = evaluateExpression(lambda.body, env, ctx);
  if (expressionCanFallThrough(lambda.body, hir)) {
    const tailInvalidations = new Map(invalidated.get(env) ?? emptyFlow());
    returnSnapshots.push({
      flow: new Map(tail),
      invalidated: tailInvalidations,
    });
    tail.forEach((origin) => addOrigin(returned, origin));
  }
  const definitelyInvalidated = intersectFlows(
    returnSnapshots.map((snapshot) => snapshot.invalidated),
  );
  const escapingRetained = escapingRetainedOrigins({
    retained,
    returned,
    transfers: transfers.values(),
  });
  return {
    parameters: lambda.parameters.map((parameter, index) => {
      const directlyRetainedPaths = pathsForParameter(escapingRetained, index);
      const externalRetainedPaths = pathsForParameter(externalRetained, index);
      const retainedPaths = mergePaths(
        directlyRetainedPaths,
        externalRetainedPaths,
      );
      const borrowedRetainedPaths = pathsForParameter(borrowedRetained, index);
      const returnedContractOrigins = returnedContractOriginsForParameter(
        returned,
        index,
      );
      const returnedOrigins = returnedContractOrigins.origins;
      const returnedBorrowedOrigins = originsForParameter(returned, index)
        .filter((origin) => origin.borrowed === true)
        .map((origin) => ({
          source: origin.sourceProjections,
          result: origin.resultProjections,
        }));
      const invalidatedPaths = pathsForParameter(definitelyInvalidated, index);
      const returnedSharedOrigins = returnedSharedOriginsForParameter({
        returned,
        returnSnapshots,
        parameter: index,
      }).map((origin) => ({
        source: origin.sourceProjections,
        result: origin.resultProjections,
      }));
      const access =
        parameter.pattern.bindingKind === "mutable-ref" ? "mutable" : "shared";
      const accessCondition = accessConditionForParameter(
        accessed,
        returned,
        index,
      );
      const returnedTypeMatchingOrigins = returnedContractOrigins.typeMatching;
      return {
        access,
        ...(access === "shared"
          ? {
              accessPaths: minimizeProjectionPaths(
                pathsForParameter(accessed, index),
              ),
            }
          : {}),
        ...(accessCondition
          ? { accessIfResultTypeDiffers: accessCondition }
          : {}),
        retained: retainedPaths.length > 0,
        returned: returnedOrigins.length > 0,
        ...(returnedTypeMatchingOrigins.length > 0
          ? { returnedTypeMatchingOrigins }
          : {}),
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(externalRetainedPaths.length > 0 ? { externalRetainedPaths } : {}),
        ...(borrowedRetainedPaths.length > 0 ? { borrowedRetainedPaths } : {}),
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
        ...(returnedBorrowedOrigins.length > 0
          ? { returnedBorrowedOrigins }
          : {}),
        ...(returnedSharedOrigins.length > 0 ? { returnedSharedOrigins } : {}),
        ...(invalidatedPaths.length > 0 ? { invalidatedPaths } : {}),
      };
    }),
    maySuspend: maySuspend.value,
    ...(transfers.size > 0
      ? { transfers: Array.from(transfers.values()) }
      : {}),
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
};
