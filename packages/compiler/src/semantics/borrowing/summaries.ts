import type { SymbolTable } from "../binder/index.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import type {
  HirBlockExpr,
  HirEffectHandlerExpr,
  HirFunction,
  HirGraph,
  HirLambdaExpr,
  HirMatchExpr,
  HirPattern,
} from "../hir/index.js";
import type { HirExprId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import type {
  CallableBorrowContract,
  CallableParameterBorrowContract,
  PlaceProjection,
  ScopedCallbackBorrowContract,
} from "./model.js";
import { mergeCallableBorrowContracts } from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import {
  expressionTypeFor,
  resolveBorrowCall,
  type ResolvedBorrowCall,
} from "./call-resolution.js";
import { expressionCanFallThrough } from "./control-flow.js";
import { typeCanCarryReference } from "./reference-bearing.js";

type ParameterOrigin = {
  parameter: number;
  sourceProjections: readonly PlaceProjection[];
  resultProjections: readonly PlaceProjection[];
};
type Flow = ReadonlyMap<string, ParameterOrigin>;
type MutableFlow = Map<string, ParameterOrigin>;
type MutableEnv = Map<SymbolId, MutableFlow>;
type ExitKind = "return" | "break" | "continue";
type ExitEnvironments = Map<ExitKind, MutableEnv[]>;

type SummaryContext = {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  borrowIndexMode: "symbolic";
  retained: MutableFlow;
  returned: MutableFlow;
  maySuspend: { value: boolean };
  scopedCallbacks: Map<string, ScopedCallbackBorrowContract>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  parameterOrigins: Map<SymbolId, number>;
  trackBorrowedParameterValues?: boolean;
  localOwnedRoots: Set<SymbolId>;
  terminatedEnvs: Map<MutableEnv, ExitKind>;
  pendingExits: Map<MutableEnv, ExitEnvironments>;
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

const originKey = (origin: ParameterOrigin): string =>
  `${origin.parameter}:${JSON.stringify(origin.sourceProjections)}:${JSON.stringify(origin.resultProjections)}`;

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

const unionFlows = (...flows: readonly Flow[]): MutableFlow => {
  const result = emptyFlow();
  flows.forEach((flow) =>
    flow.forEach((origin) => addOrigin(result, origin)),
  );
  return result;
};

const cloneEnv = (env: MutableEnv): MutableEnv =>
  new Map(
    Array.from(env, ([symbol, origins]) => [symbol, new Map(origins)] as const),
  );

const mergeEnvs = (target: MutableEnv, sources: readonly MutableEnv[]): void => {
  const symbols = new Set(
    sources.flatMap((source) => Array.from(source.keys())),
  );
  symbols.forEach((symbol) => {
    const merged = unionFlows(
      ...sources.map((source) => source.get(symbol) ?? emptyFlow()),
    );
    target.set(symbol, merged);
  });
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
        bindPattern(
          entry,
          projectFlow(flow, [{ kind: "tuple", index }]),
          env,
        ),
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
          sourceProjections: [
            ...origin.sourceProjections,
            projection,
          ],
        });
        return;
      }
      const [next, ...remaining] = origin.resultProjections;
      if (JSON.stringify(next) === JSON.stringify(projection)) {
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

const storeFlowAt = (
  flow: Flow,
  projection: PlaceProjection,
): MutableFlow =>
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

const contractPaths = (
  parameter: CallableParameterBorrowContract,
  kind: "retained" | "returned",
): readonly (readonly PlaceProjection[])[] => {
  const paths =
    kind === "retained"
      ? parameter.retainedPaths
      : parameter.returnedPaths;
  return paths && paths.length > 0 ? paths : [[]];
};

const patternSymbols = (pattern: HirPattern): SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(patternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((entry) =>
          patternSymbols(entry.pattern),
        ),
        ...(pattern.spread ? patternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? patternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const baseSymbolOfExpression = (
  exprId: HirExprId,
  ctx: Pick<SummaryContext, "hir">,
): SymbolId | undefined => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    return expr.symbol;
  }
  return expr?.exprKind === "field-access"
    ? baseSymbolOfExpression(expr.target, ctx)
    : undefined;
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
        ? ctx.dependencies
            .get(target.moduleId)
            ?.callables.get(target.symbol)?.contract
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
  ctx,
}: {
  contract: CallableBorrowContract | undefined;
  args: readonly Flow[];
  argExprs: readonly (HirExprId | undefined)[];
  ctx: SummaryContext;
}): MutableFlow => {
  if (!contract) {
    return emptyFlow();
  }
  const result = emptyFlow();
  const mutableDestinations = unionFlows(
    ...contract.parameters.flatMap((parameter, index) =>
      parameter.access === "mutable"
        ? [args[index] ?? emptyFlow()]
        : [],
    ),
  );
  const mutableDestinationParameters = new Set(
    Array.from(mutableDestinations.values(), (origin) => origin.parameter),
  );
  contract.parameters.forEach((parameter, index) => {
    const flow =
      typeof argExprs[index] === "number"
        ? (args[index] ?? emptyFlow())
        : unionFlows(
            ...(parameter.defaultOrigins ?? []).map(
              (origin) => args[origin] ?? emptyFlow(),
            ),
          );
    if (parameter.retained) {
      contractPaths(parameter, "retained").forEach((path) =>
        projectFlow(flow, path).forEach((origin) => {
          if (!mutableDestinationParameters.has(origin.parameter)) {
            addOrigin(ctx.retained, origin);
          }
        }),
      );
    }
    if (parameter.returned) {
      const origins =
        parameter.returnedOrigins && parameter.returnedOrigins.length > 0
          ? parameter.returnedOrigins
          : contractPaths(parameter, "returned").map((source) => ({
              source,
              result: [],
            }));
      origins.forEach((contractOrigin) =>
        projectFlow(flow, contractOrigin.source).forEach((origin) =>
          addOrigin(result, {
            ...origin,
            resultProjections: [
              ...contractOrigin.result,
              ...origin.resultProjections,
            ],
          }),
        ),
      );
    }
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
              callbackPath: [
                ...path,
                ...(callback.callbackPath ?? []),
              ],
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

const translateReturnedProjection = ({
  result,
  source,
  requested,
}: {
  result: readonly PlaceProjection[];
  source: readonly PlaceProjection[];
  requested: readonly PlaceProjection[];
}): readonly PlaceProjection[] | undefined => {
  const common = Math.min(result.length, requested.length);
  for (let index = 0; index < common; index += 1) {
    if (JSON.stringify(result[index]) !== JSON.stringify(requested[index])) {
      return undefined;
    }
  }
  return requested.length < result.length
    ? source
    : [...source, ...requested.slice(result.length)];
};

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
        ? [{
            origin: ctx.parameterOrigins.get(expr.symbol)!,
            path: projectionPathNames(requested),
          }]
        : [];
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return [
      ...expr.branches.flatMap((branch) =>
        callableOriginsOf(
          branch.value,
          ctx,
          new Set(seen),
          requested,
        ),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? callableOriginsOf(
            expr.defaultBranch,
            ctx,
            new Set(seen),
            requested,
          )
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
        candidate.kind === "field" &&
        candidate.name === projection.name,
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
    return resolved.contract?.parameters.flatMap((parameter, index) => {
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
          : (
              parameter.returnedPaths &&
              parameter.returnedPaths.length > 0
                ? parameter.returnedPaths
                : [[]]
            ).map((source) => ({ source, result: [] }));
      return origins.flatMap((origin) => {
        const translated = translateReturnedProjection({
          result: origin.result,
          source: origin.source,
          requested,
        });
        return translated
          ? callableOriginsOf(
              actual,
              ctx,
              new Set(seen),
              translated,
            )
          : [];
      });
    }) ?? [];
  }
  return [];
};

const evaluateBlock = (
  expr: HirBlockExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const pendingExits: ExitEnvironments = new Map();
  const collectPendingExits = (): void => {
    mergeExitEnvironments(
      pendingExits,
      takePendingExits(env, ctx),
    );
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
      bindPattern(statement.pattern, flow, env);
      patternSymbols(statement.pattern).forEach((symbol) =>
        ctx.bindingInitializers.set(symbol, statement.initializer),
      );
      const initializer = ctx.hir.expressions.get(statement.initializer);
      if (
        flow.size === 0 ||
        initializer?.exprKind === "object-literal" ||
        initializer?.exprKind === "tuple"
      ) {
        patternSymbols(statement.pattern).forEach((symbol) =>
          ctx.localOwnedRoots.add(symbol),
        );
      }
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
    const branchEnv = cloneEnv(env);
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
    const branchEnv = cloneEnv(env);
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
    branchEnvs.push(cloneEnv(env));
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
  mergeEnvs(env, branchEnvs);
  return unionFlows(...branchFlows);
};

const evaluateMatch = (
  expr: HirMatchExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const discriminant = evaluateExpression(expr.discriminant, env, ctx);
  const armEnvs: MutableEnv[] = [];
  const armExits: ExitEnvironments = new Map();
  const flows = expr.arms.map((arm) => {
    const armEnv = cloneEnv(env);
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
  mergeEnvs(env, armEnvs);
  return unionFlows(...flows);
};

const evaluateLambda = (
  expr: HirLambdaExpr,
  env: MutableEnv,
): MutableFlow =>
  unionFlows(
    ...expr.captures.map((capture) => env.get(capture.symbol) ?? emptyFlow()),
  );

const evaluateEffectHandler = (
  expr: HirEffectHandlerExpr,
  env: MutableEnv,
  ctx: SummaryContext,
): MutableFlow => {
  const flows = [evaluateExpression(expr.body, env, ctx)];
  expr.handlers.forEach((handler) => {
    const handlerEnv = cloneEnv(env);
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
    case "identifier":
      return (
        ctx.trackBorrowedParameterValues === true &&
        (env.get(expr.symbol)?.size ?? 0) > 0
      ) || expressionCanCarryReference(expr.id, ctx)
        ? new Map(env.get(expr.symbol) ?? emptyFlow())
        : emptyFlow();
    case "field-access":
      return expressionCanCarryReference(expr.id, ctx)
        ? projectFlow(
            evaluateExpression(expr.target, env, ctx),
            [{ kind: "field", name: expr.field }],
          )
        : emptyFlow();
    case "tuple":
      return unionFlows(
        ...expr.elements.map((element, index) =>
          !expressionCanCarryReference(element, ctx)
            ? emptyFlow()
            : storeFlowAt(
                evaluateExpression(element, env, ctx),
                { kind: "tuple", index },
              ),
        ),
      );
    case "object-literal":
      return unionFlows(
        ...expr.entries.map((entry) => {
          if (!expressionCanCarryReference(entry.value, ctx)) {
            return emptyFlow();
          }
          const flow = evaluateExpression(entry.value, env, ctx);
          return entry.kind === "field"
            ? storeFlowAt(flow, { kind: "field", name: entry.name })
            : flow;
        }),
      );
    case "lambda":
      return evaluateLambda(expr, env);
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
      const loopEnv = cloneEnv(env);
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
        mergeEnvs(env, [...breakEnvs, ...backEdgeEnvs]);
      } else if (returnEnvs.length > 0) {
        ctx.terminatedEnvs.set(env, "return");
      }
      if (returnEnvs.length > 0) {
        retainPendingExits(
          env,
          new Map([["return", returnEnvs]]),
          ctx,
        );
      }
      return flow;
    }
    case "while": {
      evaluateExpression(expr.condition, env, ctx);
      const conditionExits = takePendingExits(env, ctx);
      const loopEnv = cloneEnv(env);
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
    case "break":
      {
        const flow = typeof expr.value === "number"
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
      const target = ctx.hir.expressions.get(expr.target);
      if (target?.exprKind === "identifier") {
        const targetRecord = ctx.symbolTable.getSymbol(target.symbol);
        if (
          ctx.symbolTable.getScope(targetRecord.scope).kind === "module"
        ) {
          value.forEach((origin) => addOrigin(ctx.retained, origin));
          return emptyFlow();
        }
        env.set(target.symbol, new Map(value));
        return emptyFlow();
      }
      const targetFlow = evaluateExpression(expr.target, env, ctx);
      const targetRoot = baseSymbolOfExpression(expr.target, ctx);
      if (
        typeof targetRoot === "number" &&
        ctx.localOwnedRoots.has(targetRoot)
      ) {
        env.set(targetRoot, unionFlows(targetFlow, value));
        return emptyFlow();
      }
      const targetParameters = new Set(
        Array.from(targetFlow.values(), (origin) => origin.parameter),
      );
      value.forEach((origin) => {
        if (!targetParameters.has(origin.parameter)) {
          addOrigin(ctx.retained, origin);
        }
      });
      return emptyFlow();
    }
    case "call": {
      evaluateExpression(expr.callee, env, ctx);
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
        contract: resolved.contract,
        args,
        argExprs: resolved.arguments,
        ctx,
      });
      return expressionCanCarryReference(expr.id, ctx)
        ? result
        : emptyFlow();
    }
    case "method-call": {
      const evaluated = new Map<HirExprId, MutableFlow>([
        [expr.target, evaluateExpression(expr.target, env, ctx)],
        ...expr.args.map((argument) => [
          argument.expr,
          evaluateExpression(argument.expr, env, ctx),
        ] as const),
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
        ctx,
      });
      return expressionCanCarryReference(expr.id, ctx)
        ? result
        : emptyFlow();
    }
  }
};

const parameterContract = (
  functionItem: HirFunction,
  index: number,
  typing: TypingResult,
): CallableParameterBorrowContract => ({
  access:
    functionItem.parameters[index]?.pattern.bindingKind === "mutable-ref"
      ? "mutable"
      : (() => {
          const type = typing.functions.getSignature(functionItem.symbol)
            ?.parameters[index]?.type;
          if (typeof type !== "number") {
            return "shared";
          }
          return typeCanCarryReference(type, typing) ? "shared" : "owned";
        })(),
  retained: false,
  returned: false,
});

const declaredScopedCallbacks = ({
  functionItem,
  typing,
  symbolTable,
}: {
  functionItem: HirFunction;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): readonly ScopedCallbackBorrowContract[] => {
  const owner = typing.memberMetadata.get(functionItem.symbol)?.owner;
  if (typeof owner !== "number") {
    return [];
  }
  const ownerMetadata = symbolTable.getSymbol(owner).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  if (
    ownerMetadata?.intrinsicType !== STD_INTRINSIC_TYPE.sharedCell
  ) {
    return [];
  }
  const method = symbolTable.getSymbol(functionItem.symbol).name;
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
  Array.from(flow.values()).filter(
    (origin) => origin.parameter === parameter,
  );

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
  const retained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map(
    declaredScopedCallbacks({ functionItem, typing, symbolTable }).map(
      (callback) => [
        `${callback.callbackParameter}:${callback.callbackValueParameter}:`,
        callback,
      ],
    ),
  );
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const localOwnedRoots = new Set<SymbolId>();
  const terminatedEnvs = new Map<MutableEnv, ExitKind>();
  const pendingExits = new Map<MutableEnv, ExitEnvironments>();
  const defaultOrigins = new Map<number, readonly number[]>();
  const env: MutableEnv = new Map();
  functionItem.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlow(index), env);
    patternSymbols(parameter.pattern).forEach((symbol) =>
      parameterOrigins.set(symbol, index),
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
    retained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    parameterOrigins,
    localOwnedRoots,
    terminatedEnvs,
    pendingExits,
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
        new Set(
          Array.from(defaultFlow.values(), (origin) => origin.parameter),
        ),
      ),
    );
    const suppliedFlow = unionFlows(parameterFlow(index), defaultFlow);
    bindPattern(parameter.pattern, suppliedFlow, env);
  });
  const tail = evaluateExpression(functionItem.body, env, ctx);
  tail.forEach((origin) => addOrigin(returned, origin));
  return {
    parameters: functionItem.parameters.map((_parameter, index) => {
      const retainedPaths = pathsForParameter(retained, index);
      const returnedOrigins = originsForParameter(returned, index).map(
        (origin) => ({
          source: origin.sourceProjections,
          result: origin.resultProjections,
        }),
      );
      return {
        ...parameterContract(functionItem, index, typing),
        retained: retainedPaths.length > 0,
        returned: returnedOrigins.length > 0,
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
        ...(defaultOrigins.get(index)?.length
          ? { defaultOrigins: defaultOrigins.get(index) }
          : {}),
      };
    }),
    maySuspend: maySuspend.value,
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
};

const contractsEqual = (
  left: CallableBorrowContract,
  right: CallableBorrowContract,
): boolean =>
  left.parameters.length === right.parameters.length &&
  left.parameters.every((parameter, index) => {
    const candidate = right.parameters[index];
    return (
      candidate?.access === parameter.access &&
      candidate.retained === parameter.retained &&
      candidate.returned === parameter.returned &&
      JSON.stringify(candidate.retainedPaths ?? []) ===
        JSON.stringify(parameter.retainedPaths ?? []) &&
      JSON.stringify(candidate.returnedPaths ?? []) ===
        JSON.stringify(parameter.returnedPaths ?? []) &&
      JSON.stringify(candidate.returnedOrigins ?? []) ===
        JSON.stringify(parameter.returnedOrigins ?? []) &&
      JSON.stringify(candidate.defaultOrigins ?? []) ===
        JSON.stringify(parameter.defaultOrigins ?? [])
    );
  }) &&
  left.maySuspend === right.maySuspend &&
  JSON.stringify(left.scopedCallbacks ?? []) ===
    JSON.stringify(right.scopedCallbacks ?? []);

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
      (origin) =>
        origin.source.length === 0 && origin.result.length === 0,
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
  return {
    ...merged,
    parameters: merged.parameters.map((parameter) => {
      const retainedPaths = projectionPathsOrBroad(
        parameter.retainedPaths,
      );
      const returnedPaths = projectionPathsOrBroad(
        parameter.returnedPaths,
      );
      const returnedOrigins = returnedOriginsOrBroad(
        parameter.returnedOrigins,
      );
      return {
        ...parameter,
        ...(retainedPaths ? { retainedPaths } : {}),
        ...(returnedPaths ? { returnedPaths } : {}),
        ...(returnedOrigins ? { returnedOrigins } : {}),
      };
    }),
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
      {
        parameters: functionItem.parameters.map((_parameter, index) =>
          parameterContract(functionItem, index, typing),
        ),
        maySuspend: false,
        ...(declaredScopedCallbacks({
          functionItem,
          typing,
          symbolTable,
        }).length > 0
          ? {
              scopedCallbacks: declaredScopedCallbacks({
                functionItem,
                typing,
                symbolTable,
              }),
            }
          : {}),
      },
    ]),
  );

  const worklist = [...functions];
  const queued = new Set(functions.map((functionItem) => functionItem.symbol));
  while (worklist.length > 0) {
    const functionItem = worklist.shift()!;
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
    const joined = joinCallableBorrowContracts({ previous, candidate });
    if (contractsEqual(previous, joined)) {
      continue;
    }
    contracts.set(functionItem.symbol, joined);
    functions.forEach((dependent) => {
      if (queued.has(dependent.symbol)) {
        return;
      }
      queued.add(dependent.symbol);
      worklist.push(dependent);
    });
  }
  return contracts;
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
  const retained = emptyFlow();
  const returned = emptyFlow();
  const maySuspend = { value: false };
  const scopedCallbacks = new Map<string, ScopedCallbackBorrowContract>();
  const bindingInitializers = new Map<SymbolId, HirExprId>();
  const parameterOrigins = new Map<SymbolId, number>();
  const localOwnedRoots = new Set<SymbolId>();
  const terminatedEnvs = new Map<MutableEnv, ExitKind>();
  const pendingExits = new Map<MutableEnv, ExitEnvironments>();
  const env: MutableEnv = new Map();
  lambda.parameters.forEach((parameter, index) => {
    bindPattern(parameter.pattern, parameterFlow(index), env);
    patternSymbols(parameter.pattern).forEach((symbol) =>
      parameterOrigins.set(symbol, index),
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
    retained,
    returned,
    maySuspend,
    scopedCallbacks,
    bindingInitializers,
    parameterOrigins,
    trackBorrowedParameterValues: true,
    localOwnedRoots,
    terminatedEnvs,
    pendingExits,
    decls,
  };
  evaluateExpression(lambda.body, env, ctx).forEach((origin) =>
    addOrigin(returned, origin),
  );
  return {
    parameters: lambda.parameters.map((parameter, index) => {
      const retainedPaths = pathsForParameter(retained, index);
      const returnedOrigins = originsForParameter(returned, index).map(
        (origin) => ({
          source: origin.sourceProjections,
          result: origin.resultProjections,
        }),
      );
      return {
        access:
          parameter.pattern.bindingKind === "mutable-ref"
            ? "mutable"
            : "shared",
        retained: retainedPaths.length > 0,
        returned: returnedOrigins.length > 0,
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
      };
    }),
    maySuspend: maySuspend.value,
    ...(scopedCallbacks.size > 0
      ? { scopedCallbacks: Array.from(scopedCallbacks.values()) }
      : {}),
  };
};
