import {
  diagnosticFromCode,
  type Diagnostic,
} from "../../diagnostics/index.js";
import type { SymbolTable } from "../binder/index.js";
import type {
  HirExpression,
  HirFunction,
  HirGraph,
  HirLambdaExpr,
  HirPattern,
} from "../hir/index.js";
import type { HirExprId, SourceSpan, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import type {
  BorrowFact,
  BorrowPlace,
  CallableBorrowContract,
  PlaceProjection,
} from "./model.js";
import { mergeCallableBorrowContracts } from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import {
  resolveBorrowCall,
  type ResolvedBorrowCall,
} from "./call-resolution.js";
import { summarizeLambdaBorrowing } from "./summaries.js";
import { expressionCanFallThrough } from "./control-flow.js";
import { typeCanCarryReference } from "./reference-bearing.js";

type BranchPath = ReadonlyMap<number, number>;

type Event = {
  position: number;
  span: SourceSpan;
  path: BranchPath;
  loops: ReadonlySet<number>;
};

type AliasDefinition = {
  symbol: SymbolId;
  place: BorrowPlace;
  access: "shared" | "mutable";
  span: SourceSpan;
  event: Event;
  uses: readonly Event[];
  conservativeReturnedAggregate?: boolean;
  resultProjections?: readonly PlaceProjection[];
  capture?: boolean;
};

type Downgrade = {
  place: BorrowPlace;
  span: SourceSpan;
  event: Event;
};

type Termination = {
  kind: "return" | "break";
  path: BranchPath;
  loops: ReadonlySet<number>;
  position: number;
  targetLoop?: number;
};

type BodyContext = {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  decls: DeclTable;
  aliases: Map<SymbolId, AliasDefinition>;
  assignmentAliases: AliasDefinition[];
  reassignments: { symbol: SymbolId; event: Event }[];
  places: Map<SymbolId, BorrowPlace>;
  mutableOwners: Set<SymbolId>;
  events: Map<HirExprId, Event>;
  uses: Map<SymbolId, Event[]>;
  facts: BorrowFact[];
  diagnostics: Diagnostic[];
  downgraded: Downgrade[];
  terminations: Termination[];
  mutableParameters: ReadonlySet<SymbolId>;
  closureCaptures: Map<SymbolId, readonly SymbolId[]>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  unknownCallableBindings: Set<SymbolId>;
  parameterSymbols: Set<SymbolId>;
  nextPosition: number;
  nextBranch: number;
};

type BorrowCallable = Pick<HirFunction, "parameters" | "body" | "span"> & {
  captures?: HirLambdaExpr["captures"];
};

type ScanContext = {
  path: Map<number, number>;
  loops: Set<number>;
  suppressPlaceAccess?: boolean;
};

const cloneScanContext = (
  ctx: ScanContext,
  overrides?: Partial<ScanContext>,
): ScanContext => ({
  path: new Map(overrides?.path ?? ctx.path),
  loops: new Set(overrides?.loops ?? ctx.loops),
  suppressPlaceAccess:
    overrides?.suppressPlaceAccess ?? ctx.suppressPlaceAccess,
});

const typeOfExpr = (
  exprId: HirExprId,
  ctx: Pick<BodyContext, "hir" | "typing">,
): TypeId | undefined => {
  const expressionType =
    ctx.typing.resolvedExprTypes.get(exprId) ??
    ctx.typing.table.getExprType(exprId);
  if (typeof expressionType === "number") {
    return expressionType;
  }
  const expression = ctx.hir.expressions.get(exprId);
  return expression?.exprKind === "identifier"
    ? ctx.typing.valueTypes.get(expression.symbol)
    : undefined;
};

const isReferenceLike = (
  typeId: TypeId | undefined,
  ctx: Pick<BodyContext, "typing">,
): boolean => {
  if (typeof typeId !== "number") {
    return true;
  }
  return typeCanCarryReference(typeId, ctx.typing);
};

const eventFor = (
  span: SourceSpan,
  scan: ScanContext,
  ctx: BodyContext,
): Event => ({
  position: ctx.nextPosition++,
  span,
  path: new Map(scan.path),
  loops: new Set(scan.loops),
});

const recordExprEvent = (
  expr: HirExpression,
  scan: ScanContext,
  ctx: BodyContext,
): Event => {
  const event = eventFor(expr.span, scan, ctx);
  ctx.events.set(expr.id, event);
  if (expr.exprKind === "identifier") {
    const uses = ctx.uses.get(expr.symbol) ?? [];
    uses.push(event);
    ctx.uses.set(expr.symbol, uses);
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    expr.args.forEach((argument) => {
      const value = ctx.hir.expressions.get(argument.expr);
      if (value?.exprKind !== "lambda") {
        return;
      }
      value.captures.forEach((capture) => {
        const uses = ctx.uses.get(capture.symbol) ?? [];
        uses.push(event);
        ctx.uses.set(capture.symbol, uses);
      });
    });
  }
  return event;
};

const appendProjection = (
  place: BorrowPlace,
  projection: PlaceProjection,
): BorrowPlace => ({
  root: place.root,
  projections: [...place.projections, projection],
});

const baseSymbolOf = (
  exprId: HirExprId,
  ctx: Pick<BodyContext, "hir" | "symbolTable">,
): SymbolId | undefined => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "identifier") {
    return expr.symbol;
  }
  if (expr.exprKind === "field-access") {
    return baseSymbolOf(expr.target, ctx);
  }
  if (expr.exprKind === "call") {
    const callee = ctx.hir.expressions.get(expr.callee);
    if (callee?.exprKind !== "identifier") {
      return undefined;
    }
    const record = ctx.symbolTable.getSymbol(callee.symbol);
    const metadata = (record.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicName?: string;
    };
    if (
      metadata.intrinsic === true &&
      (metadata.intrinsicName ?? record.name) === "~"
    ) {
      const source = expr.args.at(-1);
      return source ? baseSymbolOf(source.expr, ctx) : undefined;
    }
  }
  return undefined;
};

const isSharedCellValueExpression = (
  exprId: HirExprId,
  ctx: Pick<BodyContext, "hir" | "symbolTable">,
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind !== "call") {
    return false;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
  };
  if (metadata.intrinsic !== true) {
    return false;
  }
  const intrinsicName = metadata.intrinsicName ?? record.name;
  if (intrinsicName === "__shared_cell_value") {
    return true;
  }
  const source = expr.args.at(-1);
  return intrinsicName === "~" && source
    ? isSharedCellValueExpression(source.expr, ctx)
    : false;
};

const numericConstant = (
  exprId: HirExprId,
  ctx: Pick<BodyContext, "hir">,
): number | undefined => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind !== "literal" || expr.literalKind !== "i32") {
    return undefined;
  }
  const value = Number(expr.value);
  return Number.isInteger(value) ? value : undefined;
};

const hasStableIndexedStorage = (
  exprId: HirExprId,
  ctx: Pick<BodyContext, "hir" | "typing">,
): boolean => {
  const typeId = typeOfExpr(exprId, ctx);
  return (
    typeof typeId === "number" &&
    ctx.typing.arena.get(typeId).kind === "fixed-array"
  );
};

const targetInfo = (
  expr: HirExpression,
  ctx: BodyContext,
): ResolvedBorrowCall => resolveBorrowCall(expr, ctx);

const reachingAliasDefinitions = (
  symbol: SymbolId,
  event: Event,
  ctx: BodyContext,
): readonly AliasDefinition[] =>
  allAliases(ctx).filter((alias) => {
    if (
      alias.symbol !== symbol ||
      alias.event.position > event.position ||
      !pathsCompatible(alias.event.path, event.path) ||
      definitionEndsBefore(alias.event, event, ctx)
    ) {
      return false;
    }
    return ![
      ...allAliases(ctx).map((candidate) => ({
        symbol: candidate.symbol,
        event: candidate.event,
      })),
      ...ctx.reassignments,
    ].some(
      (candidate) =>
        candidate.event !== alias.event &&
        candidate.symbol === symbol &&
        candidate.event.position > alias.event.position &&
        candidate.event.position <= event.position &&
        definitelyReaches(candidate.event, event),
    );
  });

const hasMutableCapabilityAt = (
  symbol: SymbolId,
  event: Event,
  ctx: BodyContext,
): boolean => {
  if (!ctx.mutableOwners.has(symbol)) {
    return false;
  }
  const reaching = reachingAliasDefinitions(symbol, event, ctx).filter(
    (definition) =>
      definition.resultProjections === undefined &&
      definition.conservativeReturnedAggregate !== true,
  );
  return (
    reaching.length === 0 ||
    reaching.every((definition) => definition.access === "mutable")
  );
};

type LambdaCaptureOrigin = {
  capture: HirLambdaExpr["captures"][number];
  place: BorrowPlace;
  source?: AliasDefinition;
};

const lambdaCaptureOrigins = (
  lambda: HirLambdaExpr,
  event: Event,
  ctx: BodyContext,
): readonly LambdaCaptureOrigin[] =>
  lambda.captures.flatMap((capture) => {
    const sources = reachingAliasDefinitions(capture.symbol, event, ctx);
    if (sources.length > 0) {
      return sources.map((source) => ({
        capture,
        place: source.place,
        source,
      }));
    }
    return [
      {
        capture,
        place: ctx.places.get(capture.symbol) ?? {
          root: capture.symbol,
          projections: [],
        },
      },
    ];
  });

const uniquePlaces = (places: readonly BorrowPlace[]): readonly BorrowPlace[] =>
  Array.from(
    new Map(places.map((place) => [JSON.stringify(place), place])).values(),
  );

const placesOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): readonly BorrowPlace[] => {
  if (seen.has(exprId)) {
    return [];
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return [];
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    return uniquePlaces(
      reaching.length > 0
        ? reaching.map((alias) => alias.place)
        : [
            ctx.places.get(expr.symbol) ?? {
              root: expr.symbol,
              projections: [],
            },
          ],
    );
  }
  if (expr.exprKind === "field-access") {
    const returned = projectedReturnedPlaces(
      expr.target,
      [{ kind: "field", name: expr.field }],
      ctx,
      seen,
    );
    if (returned.length > 0) {
      return returned;
    }
    const stored = aggregateProjectionPlaces(
      expr.target,
      expr.field,
      ctx,
      seen,
    );
    if (stored.length > 0) {
      return stored;
    }
    const targets = placesOfExpression(expr.target, ctx, seen);
    return hasConservativeReturnedAggregate(expr.target, ctx)
      ? targets
      : targets.map((target) =>
          appendProjection(target, { kind: "field", name: expr.field }),
        );
  }
  if (expr.exprKind === "tuple" || expr.exprKind === "object-literal") {
    return aggregateContentsPlaces(expr.id, ctx);
  }
  if (expr.exprKind === "lambda") {
    const event = ctx.events.get(expr.id);
    return event
      ? uniquePlaces(
          lambdaCaptureOrigins(expr, event, ctx).map((origin) => origin.place),
        )
      : [];
  }
  if (expr.exprKind === "block") {
    return typeof expr.value === "number"
      ? placesOfExpression(expr.value, ctx, seen)
      : [];
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return uniquePlaces([
      ...expr.branches.flatMap((branch) =>
        placesOfExpression(branch.value, ctx, new Set(seen)),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? placesOfExpression(expr.defaultBranch, ctx, new Set(seen))
        : []),
    ]);
  }
  if (expr.exprKind === "match") {
    return uniquePlaces(
      expr.arms.flatMap((arm) =>
        placesOfExpression(arm.value, ctx, new Set(seen)),
      ),
    );
  }
  if (expr.exprKind === "effect-handler") {
    return uniquePlaces([
      ...placesOfExpression(expr.body, ctx, new Set(seen)),
      ...expr.handlers.flatMap((handler) =>
        placesOfExpression(handler.body, ctx, new Set(seen)),
      ),
      ...(typeof expr.finallyBranch === "number"
        ? placesOfExpression(expr.finallyBranch, ctx, new Set(seen))
        : []),
    ]);
  }
  if (
    expr.exprKind === "method-call" &&
    expr.method === "subscript_get" &&
    expr.args[0]
  ) {
    const targets = placesOfExpression(expr.target, ctx, seen);
    return hasConservativeReturnedAggregate(expr.target, ctx)
      ? targets
      : targets.map((target) =>
          appendProjection(target, {
            kind: "index",
            constant: numericConstant(expr.args[0]!.expr, ctx),
            stable: hasStableIndexedStorage(expr.target, ctx),
          }),
        );
  }
  if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
    return [];
  }
  const callee =
    expr.exprKind === "call" ? ctx.hir.expressions.get(expr.callee) : undefined;
  if (callee?.exprKind === "identifier") {
    const record = ctx.symbolTable.getSymbol(callee.symbol);
    const metadata = (record.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicName?: string;
    };
    const intrinsicName = metadata.intrinsicName ?? record.name;
    if (
      metadata.intrinsic === true &&
      (intrinsicName === "~" || intrinsicName === "__shared_cell_value")
    ) {
      const value = expr.args.at(-1);
      return value ? placesOfExpression(value.expr, ctx, seen) : [];
    }
  }
  const info = targetInfo(expr, ctx);
  return returnedPlacesForCall(info, [], ctx, seen);
};

const returnedPlacesForCall = (
  info: ResolvedBorrowCall,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
  seen: Set<HirExprId>,
): readonly BorrowPlace[] =>
  uniquePlaces(
    info.contract?.parameters.flatMap((parameter, index) => {
      if (!parameter.returned) {
        return [];
      }
      const actual = info.arguments[index];
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
        const translated = translateResultProjection({
          result: origin.result,
          source: origin.source,
          requested,
        });
        if (!translated) {
          return [];
        }
        return placesAtProjection(actual, translated, ctx, new Set(seen));
      });
    }) ?? [],
  );

const translateResultProjection = ({
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
  if (requested.length < result.length) {
    return source;
  }
  return [...source, ...requested.slice(result.length)];
};

function projectedReturnedPlaces(
  exprId: HirExprId,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
  seen: Set<HirExprId>,
): readonly BorrowPlace[] {
  if (seen.has(exprId)) {
    return [];
  }
  seen = new Set(seen);
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return [];
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return returnedPlacesForCall(targetInfo(expr, ctx), requested, ctx, seen);
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    const stored = reaching.flatMap((alias) => {
      if (alias.conservativeReturnedAggregate) {
        return [alias.place];
      }
      if (!alias.resultProjections) {
        return [requested.reduce(appendProjection, alias.place)];
      }
      const translated = translateResultProjection({
        result: alias.resultProjections,
        source: [],
        requested,
      });
      return translated
        ? [translated.reduce(appendProjection, alias.place)]
        : [];
    });
    if (reaching.length > 0) {
      return uniquePlaces(stored);
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? projectedReturnedPlaces(initializer, requested, ctx, seen)
      : [];
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return projectedReturnedPlaces(expr.value, requested, ctx, seen);
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return uniquePlaces([
      ...expr.branches.flatMap((branch) =>
        projectedReturnedPlaces(branch.value, requested, ctx, new Set(seen)),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? projectedReturnedPlaces(
            expr.defaultBranch,
            requested,
            ctx,
            new Set(seen),
          )
        : []),
    ]);
  }
  if (expr.exprKind === "match") {
    return uniquePlaces(
      expr.arms.flatMap((arm) =>
        projectedReturnedPlaces(arm.value, requested, ctx, new Set(seen)),
      ),
    );
  }
  if (expr.exprKind === "object-literal") {
    if (requested.length === 0) {
      return aggregateContentsPlaces(expr.id, ctx);
    }
    const [projection, ...remaining] = requested;
    if (projection?.kind !== "field") {
      return [];
    }
    const entry = expr.entries.find(
      (candidate) =>
        candidate.kind === "field" && candidate.name === projection.name,
    );
    if (!entry) {
      return [];
    }
    return remaining.length === 0
      ? placesOfExpression(entry.value, ctx, new Set(seen))
      : placesAtProjection(entry.value, remaining, ctx, new Set(seen));
  }
  if (expr.exprKind === "tuple") {
    if (requested.length === 0) {
      return aggregateContentsPlaces(expr.id, ctx);
    }
    const [projection, ...remaining] = requested;
    if (projection?.kind !== "tuple") {
      return [];
    }
    const element = expr.elements[projection.index];
    if (typeof element !== "number") {
      return [];
    }
    return remaining.length === 0
      ? placesOfExpression(element, ctx, new Set(seen))
      : placesAtProjection(element, remaining, ctx, new Set(seen));
  }
  return [];
}

function placesAtProjection(
  exprId: HirExprId,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
  seen: Set<HirExprId>,
): readonly BorrowPlace[] {
  if (requested.length === 0) {
    return placesOfExpression(exprId, ctx, seen);
  }
  const projected = projectedReturnedPlaces(exprId, requested, ctx, seen);
  if (projected.length > 0) {
    return projected;
  }
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const hasStoredRelation =
      event &&
      reachingAliasDefinitions(expr.symbol, event, ctx).some(
        (alias) =>
          alias.conservativeReturnedAggregate === true ||
          alias.resultProjections !== undefined,
      );
    if (hasStoredRelation) {
      return [];
    }
  } else if (isAggregateExpression(exprId, ctx)) {
    return [];
  }
  return placesOfExpression(exprId, ctx, new Set(seen)).map((place) =>
    requested.reduce(appendProjection, place),
  );
}

function hasConservativeReturnedAggregate(
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): boolean {
  if (seen.has(exprId)) {
    return false;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return (
      targetInfo(expr, ctx).contract?.parameters.some(
        (parameter) =>
          parameter.returned &&
          (!parameter.returnedOrigins ||
            parameter.returnedOrigins.length === 0),
      ) === true
    );
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    if (
      event &&
      reachingAliasDefinitions(expr.symbol, event, ctx).some(
        (alias) => alias.conservativeReturnedAggregate === true,
      )
    ) {
      return true;
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? hasConservativeReturnedAggregate(initializer, ctx, seen)
      : false;
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return hasConservativeReturnedAggregate(expr.value, ctx, seen);
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      expr.branches.some((branch) =>
        hasConservativeReturnedAggregate(branch.value, ctx, new Set(seen)),
      ) ||
      (typeof expr.defaultBranch === "number" &&
        hasConservativeReturnedAggregate(
          expr.defaultBranch,
          ctx,
          new Set(seen),
        ))
    );
  }
  if (expr.exprKind === "match") {
    return expr.arms.some((arm) =>
      hasConservativeReturnedAggregate(arm.value, ctx, new Set(seen)),
    );
  }
  return false;
}

function aggregateProjectionPlaces(
  targetId: HirExprId,
  field: string,
  ctx: BodyContext,
  seen: Set<HirExprId>,
): readonly BorrowPlace[] {
  const target = ctx.hir.expressions.get(targetId);
  if (target?.exprKind !== "identifier") {
    return [];
  }
  const initializer = ctx.bindingInitializers.get(target.symbol);
  if (typeof initializer !== "number" || seen.has(initializer)) {
    return [];
  }
  const aggregate = ctx.hir.expressions.get(initializer);
  if (aggregate?.exprKind === "object-literal") {
    const entry = aggregate.entries.find(
      (candidate) => candidate.kind === "field" && candidate.name === field,
    );
    return entry ? placesOfExpression(entry.value, ctx, new Set(seen)) : [];
  }
  if (aggregate?.exprKind === "tuple") {
    const index = Number(field);
    const element = Number.isInteger(index)
      ? aggregate.elements[index]
      : undefined;
    return typeof element === "number"
      ? placesOfExpression(element, ctx, new Set(seen))
      : [];
  }
  return aggregate?.exprKind === "identifier"
    ? aggregateProjectionPlaces(initializer, field, ctx, seen)
    : [];
}

type AggregateOrigin = {
  place: BorrowPlace;
  resultProjections: readonly PlaceProjection[];
};

const uniqueAggregateOrigins = (
  origins: readonly AggregateOrigin[],
): readonly AggregateOrigin[] =>
  Array.from(
    new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values(),
  );

const aggregateOriginsOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): readonly AggregateOrigin[] => {
  if (seen.has(exprId)) {
    return [];
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "block" && typeof expr.value === "number") {
    return aggregateOriginsOfExpression(expr.value, ctx, seen);
  }
  if (expr?.exprKind === "if" || expr?.exprKind === "cond") {
    return uniqueAggregateOrigins([
      ...expr.branches.flatMap((branch) =>
        aggregateOriginsOfExpression(branch.value, ctx, new Set(seen)),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? aggregateOriginsOfExpression(expr.defaultBranch, ctx, new Set(seen))
        : []),
    ]);
  }
  if (expr?.exprKind === "match") {
    return uniqueAggregateOrigins(
      expr.arms.flatMap((arm) =>
        aggregateOriginsOfExpression(arm.value, ctx, new Set(seen)),
      ),
    );
  }
  if (expr?.exprKind === "field-access") {
    const requested = {
      kind: "field" as const,
      name: expr.field,
    };
    return uniqueAggregateOrigins(
      aggregateOriginsOfExpression(expr.target, ctx, new Set(seen)).flatMap(
        (origin) => {
          const [next, ...remaining] = origin.resultProjections;
          if (
            !next ||
            JSON.stringify(next) !== JSON.stringify(requested) ||
            remaining.length === 0
          ) {
            return [];
          }
          return [
            {
              place: origin.place,
              resultProjections: remaining,
            },
          ];
        },
      ),
    );
  }
  if (expr?.exprKind === "call" || expr?.exprKind === "method-call") {
    const info = targetInfo(expr, ctx);
    return uniqueAggregateOrigins(
      info.contract?.parameters.flatMap((parameter, index) => {
        const actual = info.arguments[index];
        if (typeof actual !== "number" || !parameter.returnedOrigins) {
          return [];
        }
        return parameter.returnedOrigins.flatMap((origin) => {
          if (origin.result.length === 0) {
            return [];
          }
          return placesAtProjection(
            actual,
            origin.source,
            ctx,
            new Set(seen),
          ).map((place) => ({
            place,
            resultProjections: origin.result,
          }));
        });
      }) ?? [],
    );
  }
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    const contained = reaching.map((alias) => ({
      place: alias.place,
      resultProjections: alias.resultProjections ?? [],
    }));
    if (reaching.length > 0) {
      return uniqueAggregateOrigins(contained);
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? aggregateOriginsOfExpression(initializer, ctx, seen)
      : [];
  }
  if (expr?.exprKind === "tuple") {
    return uniqueAggregateOrigins(
      expr.elements.flatMap((value, index) => {
        const projection = { kind: "tuple" as const, index };
        const direct = isReferenceLike(typeOfExpr(value, ctx), ctx)
          ? placesOfExpression(value, ctx).map((place) => ({
              place,
              resultProjections: [projection],
            }))
          : [];
        const nested = aggregateOriginsOfExpression(
          value,
          ctx,
          new Set(seen),
        ).map((origin) => ({
          ...origin,
          resultProjections: [projection, ...origin.resultProjections],
        }));
        return [...direct, ...nested];
      }),
    );
  }
  if (expr?.exprKind === "object-literal") {
    return uniqueAggregateOrigins(
      expr.entries.flatMap((entry) => {
        if (entry.kind !== "field") {
          return aggregateOriginsOfExpression(entry.value, ctx, new Set(seen));
        }
        const projection = {
          kind: "field" as const,
          name: entry.name,
        };
        const direct = isReferenceLike(typeOfExpr(entry.value, ctx), ctx)
          ? placesOfExpression(entry.value, ctx).map((place) => ({
              place,
              resultProjections: [projection],
            }))
          : [];
        const nested = aggregateOriginsOfExpression(
          entry.value,
          ctx,
          new Set(seen),
        ).map((origin) => ({
          ...origin,
          resultProjections: [projection, ...origin.resultProjections],
        }));
        return [...direct, ...nested];
      }),
    );
  }
  return [];
};

const aggregateContentsPlaces = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] =>
  uniquePlaces(
    aggregateOriginsOfExpression(exprId, ctx).map((origin) => origin.place),
  );

const placesStoredByExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  if (
    isAggregateExpression(exprId, ctx) ||
    isSharedCellValueExpression(exprId, ctx)
  ) {
    return [];
  }
  return isReferenceLike(typeOfExpr(exprId, ctx), ctx)
    ? placesOfExpression(exprId, ctx)
    : [];
};

const isAggregateExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): boolean => {
  if (seen.has(exprId)) {
    return false;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "tuple" || expr?.exprKind === "object-literal") {
    return true;
  }
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    if (
      event &&
      reachingAliasDefinitions(expr.symbol, event, ctx).some(
        (alias) =>
          alias.conservativeReturnedAggregate === true ||
          (alias.resultProjections?.length ?? 0) > 0,
      )
    ) {
      return true;
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? isAggregateExpression(initializer, ctx, seen)
      : false;
  }
  if (expr?.exprKind === "block" && typeof expr.value === "number") {
    return isAggregateExpression(expr.value, ctx, seen);
  }
  if (expr?.exprKind === "if" || expr?.exprKind === "cond") {
    const values = [
      ...expr.branches.map((branch) => branch.value),
      ...(typeof expr.defaultBranch === "number" ? [expr.defaultBranch] : []),
    ];
    return (
      values.length > 0 &&
      values.every((value) => isAggregateExpression(value, ctx, new Set(seen)))
    );
  }
  if (expr?.exprKind === "match") {
    return (
      expr.arms.length > 0 &&
      expr.arms.every((arm) =>
        isAggregateExpression(arm.value, ctx, new Set(seen)),
      )
    );
  }
  if (expr?.exprKind === "call" || expr?.exprKind === "method-call") {
    return (
      targetInfo(expr, ctx).contract?.parameters.some(
        (parameter) =>
          parameter.returnedOrigins?.some(
            (origin) => origin.result.length > 0,
          ) === true,
      ) === true
    );
  }
  return false;
};

const projectionsEqual = (
  left: PlaceProjection,
  right: PlaceProjection,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const projectAggregateOrigin = (
  origin: AggregateOrigin,
  projection: PlaceProjection,
): AggregateOrigin | undefined => {
  const [next, ...remaining] = origin.resultProjections;
  if (!next) {
    return {
      place: appendProjection(origin.place, projection),
      resultProjections: [],
    };
  }
  return projectionsEqual(next, projection)
    ? { place: origin.place, resultProjections: remaining }
    : undefined;
};

const bindPatternAggregateOrigin = ({
  pattern,
  origin,
  mutable,
  span,
  event,
  ctx,
}: {
  pattern: HirPattern;
  origin: AggregateOrigin;
  mutable: boolean;
  span: SourceSpan;
  event: Event;
  ctx: BodyContext;
}): void => {
  switch (pattern.kind) {
    case "identifier": {
      const alias: AliasDefinition = {
        symbol: pattern.symbol,
        place: origin.place,
        access:
          pattern.bindingKind === "mutable-ref" || mutable
            ? "mutable"
            : "shared",
        span: pattern.span ?? span,
        event,
        uses: [],
        ...(origin.resultProjections.length > 0
          ? { resultProjections: origin.resultProjections }
          : {}),
      };
      if (ctx.aliases.has(pattern.symbol)) {
        ctx.assignmentAliases.push(alias);
      } else {
        ctx.aliases.set(pattern.symbol, alias);
      }
      return;
    }
    case "tuple":
      pattern.elements.forEach((entry, index) => {
        const projected = projectAggregateOrigin(origin, {
          kind: "tuple",
          index,
        });
        if (projected) {
          bindPatternAggregateOrigin({
            pattern: entry,
            origin: projected,
            mutable,
            span,
            event,
            ctx,
          });
        }
      });
      return;
    case "destructure":
      pattern.fields.forEach((field) => {
        const projected = projectAggregateOrigin(origin, {
          kind: "field",
          name: field.name,
        });
        if (projected) {
          bindPatternAggregateOrigin({
            pattern: field.pattern,
            origin: projected,
            mutable,
            span,
            event,
            ctx,
          });
        }
      });
      if (pattern.spread) {
        bindPatternAggregateOrigin({
          pattern: pattern.spread,
          origin,
          mutable,
          span,
          event,
          ctx,
        });
      }
      return;
    case "type":
      if (pattern.binding) {
        bindPatternAggregateOrigin({
          pattern: pattern.binding,
          origin,
          mutable,
          span,
          event,
          ctx,
        });
      }
      return;
    case "wildcard":
      return;
  }
};

const bindAggregatePatternOrigins = ({
  pattern,
  value,
  mutable,
  span,
  event,
  ctx,
}: {
  pattern: HirPattern;
  value: HirExprId;
  mutable: boolean;
  span: SourceSpan;
  event: Event;
  ctx: BodyContext;
}): void => {
  const expression = ctx.hir.expressions.get(value);
  if (pattern.kind === "tuple" && expression?.exprKind === "tuple") {
    pattern.elements.forEach((entry, index) => {
      const element = expression.elements[index];
      if (typeof element === "number") {
        bindAggregatePatternOrigins({
          pattern: entry,
          value: element,
          mutable,
          span,
          event,
          ctx,
        });
      }
    });
    return;
  }
  if (pattern.kind === "tuple") {
    const origins = aggregateOriginsOfExpression(value, ctx);
    if (origins.length > 0) {
      origins.forEach((origin) =>
        bindPatternAggregateOrigin({
          pattern,
          origin,
          mutable,
          span,
          event,
          ctx,
        }),
      );
      return;
    }
    pattern.elements.forEach((entry, index) => {
      const sources = placesAtProjection(
        value,
        [{ kind: "tuple", index }],
        ctx,
        new Set(),
      );
      sources.forEach((source) =>
        bindPatternPlaces({
          pattern: entry,
          source,
          mutable,
          span,
          event,
          ctx,
        }),
      );
    });
    return;
  }
  if (
    pattern.kind === "destructure" &&
    expression?.exprKind === "object-literal"
  ) {
    pattern.fields.forEach((field) => {
      const entry = expression.entries.find(
        (candidate) =>
          candidate.kind === "field" && candidate.name === field.name,
      );
      if (entry) {
        bindAggregatePatternOrigins({
          pattern: field.pattern,
          value: entry.value,
          mutable,
          span,
          event,
          ctx,
        });
      }
    });
    return;
  }
  if (pattern.kind === "destructure") {
    const origins = aggregateOriginsOfExpression(value, ctx);
    if (origins.length > 0) {
      origins.forEach((origin) =>
        bindPatternAggregateOrigin({
          pattern,
          origin,
          mutable,
          span,
          event,
          ctx,
        }),
      );
      return;
    }
    pattern.fields.forEach((field) => {
      const sources = placesAtProjection(
        value,
        [{ kind: "field", name: field.name }],
        ctx,
        new Set(),
      );
      sources.forEach((source) =>
        bindPatternPlaces({
          pattern: field.pattern,
          source,
          mutable,
          span,
          event,
          ctx,
        }),
      );
    });
    return;
  }
  if (pattern.kind === "type" && pattern.binding) {
    bindAggregatePatternOrigins({
      pattern: pattern.binding,
      value,
      mutable,
      span,
      event,
      ctx,
    });
    return;
  }
  if (pattern.kind !== "identifier") {
    return;
  }
  const directPlaces = placesStoredByExpression(value, ctx);
  const conservativeReturnedAggregate = hasConservativeReturnedAggregate(
    value,
    ctx,
  );
  if (directPlaces.length > 0) {
    directPlaces.forEach((source) =>
      bindPatternPlaces({
        pattern,
        source,
        mutable,
        span,
        event,
        ctx,
        conservativeReturnedAggregate,
      }),
    );
  }
  aggregateOriginsOfExpression(value, ctx).forEach((origin) => {
    const alias: AliasDefinition = {
      symbol: pattern.symbol,
      place: origin.place,
      access:
        directPlaces.length > 0 &&
        (mutable || pattern.bindingKind === "mutable-ref")
          ? "mutable"
          : "shared",
      span: pattern.span ?? span,
      event,
      uses: [],
      ...(origin.resultProjections.length > 0
        ? { resultProjections: origin.resultProjections }
        : {}),
      ...(conservativeReturnedAggregate
        ? { conservativeReturnedAggregate: true }
        : {}),
    };
    if (ctx.aliases.has(pattern.symbol)) {
      ctx.assignmentAliases.push(alias);
    } else {
      ctx.aliases.set(pattern.symbol, alias);
    }
  });
};

const bindPatternPlaces = ({
  pattern,
  source,
  mutable,
  span,
  event,
  ctx,
  projection,
  conservativeReturnedAggregate = false,
}: {
  pattern: HirPattern;
  source?: BorrowPlace;
  mutable: boolean;
  span: SourceSpan;
  event: Event;
  ctx: BodyContext;
  projection?: PlaceProjection;
  conservativeReturnedAggregate?: boolean;
}): void => {
  const projected =
    source && projection ? appendProjection(source, projection) : source;
  switch (pattern.kind) {
    case "identifier": {
      const bindingMutable =
        pattern.bindingKind === "mutable-ref" || (mutable && !projected);
      if (projected) {
        ctx.places.set(pattern.symbol, projected);
        const alias: AliasDefinition = {
          symbol: pattern.symbol,
          place: projected,
          access: bindingMutable ? "mutable" : "shared",
          span: pattern.span ?? span,
          event,
          uses: [],
          ...(conservativeReturnedAggregate
            ? { conservativeReturnedAggregate: true }
            : {}),
        };
        if (ctx.aliases.has(pattern.symbol)) {
          ctx.assignmentAliases.push(alias);
        } else {
          ctx.aliases.set(pattern.symbol, alias);
        }
      } else {
        ctx.places.set(pattern.symbol, {
          root: pattern.symbol,
          projections: [],
        });
      }
      if (bindingMutable) {
        ctx.mutableOwners.add(pattern.symbol);
      }
      return;
    }
    case "tuple":
      pattern.elements.forEach((entry, index) =>
        bindPatternPlaces({
          pattern: entry,
          source: projected,
          mutable,
          span,
          event,
          ctx,
          projection: { kind: "tuple", index },
          conservativeReturnedAggregate,
        }),
      );
      return;
    case "destructure":
      pattern.fields.forEach((entry) =>
        bindPatternPlaces({
          pattern: entry.pattern,
          source: projected,
          mutable,
          span,
          event,
          ctx,
          projection: { kind: "field", name: entry.name },
          conservativeReturnedAggregate,
        }),
      );
      if (pattern.spread) {
        bindPatternPlaces({
          pattern: pattern.spread,
          source: projected,
          mutable,
          span,
          event,
          ctx,
          conservativeReturnedAggregate,
        });
      }
      return;
    case "type":
      if (pattern.binding) {
        bindPatternPlaces({
          pattern: pattern.binding,
          source: projected,
          mutable,
          span,
          event,
          ctx,
          conservativeReturnedAggregate,
        });
      }
      return;
    case "wildcard":
      return;
  }
};

const scanBranches = (
  expr: Extract<HirExpression, { exprKind: "if" | "cond" }>,
  scan: ScanContext,
  ctx: BodyContext,
): void => {
  const branchId = ctx.nextBranch++;
  expr.branches.forEach((branch, index) => {
    scanExpression(branch.condition, scan, ctx);
    const branchScan = cloneScanContext(scan);
    branchScan.path.set(branchId, index);
    scanExpression(branch.value, branchScan, ctx);
  });
  if (typeof expr.defaultBranch === "number") {
    const branchScan = cloneScanContext(scan);
    branchScan.path.set(branchId, expr.branches.length);
    scanExpression(expr.defaultBranch, branchScan, ctx);
  }
};

const scanExpression = (
  exprId: HirExprId,
  scan: ScanContext,
  ctx: BodyContext,
): void => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return;
  }
  switch (expr.exprKind) {
    case "literal":
    case "identifier":
    case "overload-set":
      break;
    case "field-access":
      scanExpression(expr.target, { ...scan, suppressPlaceAccess: true }, ctx);
      break;
    case "tuple":
      expr.elements.forEach((element) => scanExpression(element, scan, ctx));
      break;
    case "object-literal":
      expr.entries.forEach((entry) => scanExpression(entry.value, scan, ctx));
      break;
    case "call":
      scanExpression(expr.callee, { ...scan, suppressPlaceAccess: true }, ctx);
      expr.args.forEach((arg) =>
        scanExpression(arg.expr, { ...scan, suppressPlaceAccess: true }, ctx),
      );
      break;
    case "method-call":
      scanExpression(expr.target, { ...scan, suppressPlaceAccess: true }, ctx);
      expr.args.forEach((arg) =>
        scanExpression(arg.expr, { ...scan, suppressPlaceAccess: true }, ctx),
      );
      break;
    case "block": {
      let fallsThrough = true;
      for (const statementId of expr.statements) {
        const statement = ctx.hir.statements.get(statementId);
        if (!statement) {
          continue;
        }
        if (statement.kind === "let") {
          scanExpression(
            statement.initializer,
            { ...scan, suppressPlaceAccess: true },
            ctx,
          );
          const event = eventFor(statement.span, scan, ctx);
          const sources = placesStoredByExpression(statement.initializer, ctx);
          const bind = (source?: BorrowPlace): void =>
            bindPatternPlaces({
              pattern: statement.pattern,
              source,
              mutable:
                statement.mutable ||
                statement.pattern.bindingKind === "mutable-ref",
              span: statement.span,
              event,
              ctx,
              conservativeReturnedAggregate: hasConservativeReturnedAggregate(
                statement.initializer,
                ctx,
              ),
            });
          if (sources.length === 0) {
            bind();
          } else {
            sources.forEach(bind);
          }
          const initializer = ctx.hir.expressions.get(statement.initializer);
          if (
            isAggregateExpression(statement.initializer, ctx) ||
            aggregateContentsPlaces(statement.initializer, ctx).length > 0
          ) {
            bindAggregatePatternOrigins({
              pattern: statement.pattern,
              value: statement.initializer,
              mutable:
                statement.mutable ||
                statement.pattern.bindingKind === "mutable-ref",
              span: statement.span,
              event,
              ctx,
            });
          }
          patternSymbols(statement.pattern).forEach((symbol) =>
            ctx.bindingInitializers.set(symbol, statement.initializer),
          );
          if (initializer?.exprKind === "lambda") {
            const closureSymbols = patternSymbols(statement.pattern);
            const captures = initializer.captures.map(
              (capture) => capture.symbol,
            );
            const captureOrigins = lambdaCaptureOrigins(
              initializer,
              event,
              ctx,
            );
            closureSymbols.forEach((symbol) => {
              ctx.closureCaptures.set(symbol, captures);
              captureOrigins.forEach(({ capture, place }) =>
                ctx.assignmentAliases.push({
                  symbol,
                  place,
                  access: capture.mutable ? "mutable" : "shared",
                  span: capture.span,
                  event,
                  uses: [],
                  capture: true,
                }),
              );
            });
          }
          fallsThrough = expressionCanFallThrough(
            statement.initializer,
            ctx.hir,
          );
          if (!fallsThrough) {
            break;
          }
          continue;
        }
        if (statement.kind === "return") {
          if (typeof statement.value === "number") {
            scanExpression(statement.value, scan, ctx);
          }
          ctx.terminations.push({
            kind: "return",
            path: new Map(scan.path),
            loops: new Set(scan.loops),
            position: ctx.nextPosition,
          });
          fallsThrough = false;
          break;
        }
        scanExpression(statement.expr, scan, ctx);
        fallsThrough = expressionCanFallThrough(statement.expr, ctx.hir);
        if (!fallsThrough) {
          break;
        }
      }
      if (fallsThrough && typeof expr.value === "number") {
        scanExpression(expr.value, scan, ctx);
      }
      break;
    }
    case "if":
    case "cond":
      scanBranches(expr, scan, ctx);
      break;
    case "match": {
      scanExpression(expr.discriminant, scan, ctx);
      const branchId = ctx.nextBranch++;
      expr.arms.forEach((arm, index) => {
        const armScan = cloneScanContext(scan);
        armScan.path.set(branchId, index);
        const event = eventFor(arm.pattern.span ?? expr.span, armScan, ctx);
        bindAggregatePatternOrigins({
          pattern: arm.pattern,
          value: expr.discriminant,
          mutable: false,
          span: arm.pattern.span ?? expr.span,
          event,
          ctx,
        });
        if (typeof arm.guard === "number") {
          scanExpression(arm.guard, armScan, ctx);
        }
        scanExpression(arm.value, armScan, ctx);
      });
      break;
    }
    case "loop": {
      const loopScan = cloneScanContext(scan);
      loopScan.loops.add(expr.id);
      scanExpression(expr.body, loopScan, ctx);
      break;
    }
    case "while": {
      scanExpression(expr.condition, scan, ctx);
      const loopScan = cloneScanContext(scan);
      loopScan.loops.add(expr.id);
      scanExpression(expr.body, loopScan, ctx);
      break;
    }
    case "lambda":
      break;
    case "effect-handler":
      scanExpression(expr.body, scan, ctx);
      expr.handlers.forEach((handler) =>
        scanExpression(handler.body, scan, ctx),
      );
      if (typeof expr.finallyBranch === "number") {
        scanExpression(expr.finallyBranch, scan, ctx);
      }
      break;
    case "assign":
      if (typeof expr.target === "number") {
        const target = ctx.hir.expressions.get(expr.target);
        if (target?.exprKind !== "identifier") {
          scanExpression(
            expr.target,
            { ...scan, suppressPlaceAccess: true },
            ctx,
          );
        }
      }
      scanExpression(expr.value, scan, ctx);
      if (typeof expr.target === "number") {
        const target = ctx.hir.expressions.get(expr.target);
        if (target?.exprKind === "identifier") {
          const assigned = ctx.hir.expressions.get(expr.value);
          const aggregateAssignment =
            assigned?.exprKind === "tuple" ||
            assigned?.exprKind === "object-literal" ||
            isAggregateExpression(expr.value, ctx) ||
            aggregateContentsPlaces(expr.value, ctx).length > 0;
          if (aggregateAssignment) {
            ctx.bindingInitializers.set(target.symbol, expr.value);
          } else {
            ctx.bindingInitializers.delete(target.symbol);
          }
          ctx.unknownCallableBindings.add(target.symbol);
          const event = eventFor(expr.span, scan, ctx);
          ctx.reassignments.push({ symbol: target.symbol, event });
          const sources = placesStoredByExpression(expr.value, ctx);
          const sourceActor = baseSymbolOf(expr.value, ctx);
          const preservesMutableCapability =
            hasMutableCapabilityAt(target.symbol, event, ctx) &&
            typeof sourceActor === "number" &&
            hasMutableCapabilityAt(sourceActor, event, ctx);
          if (sources.length > 0) {
            sources.forEach((source) =>
              ctx.assignmentAliases.push({
                symbol: target.symbol,
                place: source,
                access: preservesMutableCapability ? "mutable" : "shared",
                span: expr.span,
                event,
                uses: [],
                ...(hasConservativeReturnedAggregate(expr.value, ctx)
                  ? { conservativeReturnedAggregate: true }
                  : {}),
              }),
            );
          }
          const aggregateOrigins = aggregateAssignment
            ? aggregateOriginsOfExpression(expr.value, ctx)
            : [];
          if (aggregateAssignment) {
            aggregateOrigins.forEach((origin) =>
              ctx.assignmentAliases.push({
                symbol: target.symbol,
                place: origin.place,
                access: "shared",
                span: expr.span,
                event,
                uses: [],
                ...(origin.resultProjections.length > 0
                  ? { resultProjections: origin.resultProjections }
                  : {}),
                ...(hasConservativeReturnedAggregate(expr.value, ctx)
                  ? { conservativeReturnedAggregate: true }
                  : {}),
              }),
            );
          }
        }
      }
      break;
    case "break":
      if (typeof expr.value === "number") {
        scanExpression(expr.value, scan, ctx);
      }
      ctx.terminations.push({
        kind: "break",
        path: new Map(scan.path),
        loops: new Set(scan.loops),
        position: ctx.nextPosition,
        targetLoop: Array.from(scan.loops).at(-1),
      });
      break;
    case "continue":
      break;
  }
  recordExprEvent(expr, scan, ctx);
};

const pathsCompatible = (left: BranchPath, right: BranchPath): boolean => {
  for (const [branch, alternative] of left) {
    const candidate = right.get(branch);
    if (candidate !== undefined && candidate !== alternative) {
      return false;
    }
  }
  return true;
};

const pathIncludes = (path: BranchPath, required: BranchPath): boolean =>
  Array.from(required).every(
    ([branch, alternative]) => path.get(branch) === alternative,
  );

const definitionEndsBefore = (
  definition: Event,
  use: Event,
  ctx: BodyContext,
): boolean =>
  ctx.terminations.some((termination) => {
    const reachesRelevantScope =
      termination.kind === "return"
        ? Array.from(termination.loops).every((loop) =>
            definition.loops.has(loop),
          )
        : typeof termination.targetLoop === "number" &&
          definition.loops.has(termination.targetLoop) &&
          use.loops.has(termination.targetLoop);
    return (
      definition.position <= termination.position &&
      termination.position < use.position &&
      pathIncludes(definition.path, termination.path) &&
      reachesRelevantScope &&
      pathsCompatible(termination.path, use.path)
    );
  });

const allAliases = (ctx: BodyContext): readonly AliasDefinition[] => [
  ...ctx.aliases.values(),
  ...ctx.assignmentAliases,
];

const definitelyReaches = (definition: Event, use: Event): boolean =>
  Array.from(definition.path).every(
    ([branch, alternative]) => use.path.get(branch) === alternative,
  ) && Array.from(definition.loops).every((loop) => use.loops.has(loop));

const placeOverlaps = (left: BorrowPlace, right: BorrowPlace): boolean => {
  if (left.root !== right.root) {
    return false;
  }
  const length = Math.min(left.projections.length, right.projections.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.projections[index]!;
    const b = right.projections[index]!;
    if (a.kind !== b.kind) {
      return true;
    }
    if (a.kind === "field" && b.kind === "field" && a.name !== b.name) {
      return false;
    }
    if (a.kind === "tuple" && b.kind === "tuple" && a.index !== b.index) {
      return false;
    }
    if (
      a.kind === "index" &&
      b.kind === "index" &&
      a.stable &&
      b.stable &&
      a.constant !== undefined &&
      b.constant !== undefined &&
      a.constant !== b.constant
    ) {
      return false;
    }
  }
  return true;
};

const placeName = (place: BorrowPlace, ctx: BodyContext): string => {
  const root = ctx.symbolTable.getSymbol(place.root).name;
  return place.projections.reduce((name, projection) => {
    if (projection.kind === "field") {
      return `${name}.${projection.name}`;
    }
    if (projection.kind === "tuple") {
      return `${name}.${projection.index}`;
    }
    return `${name}[${projection.constant ?? "?"}]`;
  }, root);
};

const aliasActiveAt = (
  alias: AliasDefinition,
  event: Event,
  ctx: BodyContext,
): boolean => {
  const loopCarried = definitionCanReachOnLoopBackedge(alias.event, event, ctx);
  if (alias.event.position > event.position && !loopCarried) {
    return false;
  }
  if (definitionEndsBefore(alias.event, event, ctx)) {
    return false;
  }
  if (!loopCarried && !pathsCompatible(alias.event.path, event.path)) {
    return false;
  }
  if (loopCarried && loopCarriedDefinitionIsOverwritten(alias, event, ctx)) {
    return false;
  }
  if (
    !loopCarried &&
    [
      ...allAliases(ctx).map((candidate) => ({
        symbol: candidate.symbol,
        event: candidate.event,
      })),
      ...ctx.reassignments,
    ].some(
      (candidate) =>
        candidate.event !== alias.event &&
        candidate.symbol === alias.symbol &&
        candidate.event.position > alias.event.position &&
        candidate.event.position <= event.position &&
        definitelyReaches(candidate.event, event),
    )
  ) {
    return false;
  }
  return alias.uses.some((use) => {
    if (!pathsCompatible(use.path, event.path)) {
      return false;
    }
    if (use.position >= event.position) {
      return true;
    }
    const enclosingLoop = Array.from(event.loops).find(
      (loop) => use.loops.has(loop) && !alias.event.loops.has(loop),
    );
    return enclosingLoop !== undefined;
  });
};

const definitionCanReachOnLoopBackedge = (
  definition: Event,
  use: Event,
  ctx: BodyContext,
): boolean => {
  if (definition.position <= use.position) {
    return false;
  }
  const sharedLoops = Array.from(definition.loops).filter((loop) =>
    use.loops.has(loop),
  );
  if (sharedLoops.length === 0) {
    return false;
  }
  return sharedLoops.some(
    (loop) =>
      !ctx.terminations.some(
        (termination) =>
          termination.position > definition.position &&
          pathIncludes(definition.path, termination.path) &&
          (termination.kind === "return" ||
            (termination.kind === "break" && termination.targetLoop === loop)),
      ),
  );
};

const loopCarriedDefinitionIsOverwritten = (
  alias: AliasDefinition,
  use: Event,
  ctx: BodyContext,
): boolean => {
  const sharedLoops = new Set(
    Array.from(alias.event.loops).filter((loop) => use.loops.has(loop)),
  );
  const candidates = [
    ...allAliases(ctx).map((candidate) => ({
      symbol: candidate.symbol,
      event: candidate.event,
    })),
    ...ctx.reassignments,
  ];
  return candidates.some((candidate) => {
    if (
      candidate.event === alias.event ||
      candidate.event.position === alias.event.position ||
      candidate.symbol !== alias.symbol ||
      !Array.from(candidate.event.loops).some((loop) => sharedLoops.has(loop))
    ) {
      return false;
    }
    if (candidate.event.position < use.position) {
      return definitelyReaches(candidate.event, use);
    }
    return (
      candidate.event.position > alias.event.position &&
      pathIncludes(alias.event.path, candidate.event.path)
    );
  });
};

const addDiagnostic = (diagnostic: Diagnostic, ctx: BodyContext): void => {
  const key = `${diagnostic.code}:${diagnostic.span.file}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
  const duplicate = ctx.diagnostics.some(
    (candidate) =>
      `${candidate.code}:${candidate.span.file}:${candidate.span.start}:${candidate.span.end}:${candidate.message}` ===
      key,
  );
  if (!duplicate) {
    ctx.diagnostics.push(diagnostic);
  }
};

const reportConflict = ({
  attempted,
  access,
  existing,
  event,
  ctx,
}: {
  attempted: BorrowPlace;
  access: "shared" | "mutable";
  existing: AliasDefinition;
  event: Event;
  ctx: BodyContext;
}): void => {
  const lastUse = existing.uses
    .filter((use) => pathsCompatible(use.path, event.path))
    .sort((left, right) => right.position - left.position)[0];
  const related = [
    diagnosticFromCode({
      code: "TY0048",
      params: {
        kind: "borrow-origin",
        place: placeName(existing.place, ctx),
        borrow: existing.access,
      },
      span: existing.span,
      severity: "note",
    }),
    ...(lastUse
      ? [
          diagnosticFromCode({
            code: "TY0048",
            params: {
              kind: "borrow-last-use" as const,
              alias: ctx.symbolTable.getSymbol(existing.symbol).name,
            },
            span: lastUse.span,
            severity: "note",
          }),
        ]
      : []),
  ];
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0048",
      params: {
        kind: "borrow-conflict",
        access: access === "mutable" ? "mutably borrow" : "read",
        place: placeName(attempted, ctx),
        existing: existing.access,
      },
      span: event.span,
      related,
    }),
    ctx,
  );
};

const activeDowngradeFor = (
  place: BorrowPlace,
  event: Event,
  ctx: BodyContext,
): Downgrade | undefined =>
  ctx.downgraded.find(
    (entry) =>
      entry.event.position <= event.position &&
      pathsCompatible(entry.event.path, event.path) &&
      !definitionEndsBefore(entry.event, event, ctx) &&
      placeOverlaps(entry.place, place),
  );

const checkAccess = ({
  place,
  actor,
  access,
  event,
  ctx,
}: {
  place: BorrowPlace;
  actor?: SymbolId;
  access: "shared" | "mutable";
  event: Event;
  ctx: BodyContext;
}): void => {
  if (access === "mutable") {
    const downgrade = activeDowngradeFor(place, event, ctx);
    if (downgrade) {
      const name = placeName(place, ctx);
      addDiagnostic(
        diagnosticFromCode({
          code: "TY0051",
          params: { kind: "permanently-shared", binding: name },
          span: event.span,
          related: [
            diagnosticFromCode({
              code: "TY0051",
              params: { kind: "shared-here", binding: name },
              span: downgrade.span,
              severity: "note",
            }),
          ],
        }),
        ctx,
      );
    }
  }

  allAliases(ctx).forEach((alias) => {
    if (alias.symbol === actor || !placeOverlaps(alias.place, place)) {
      return;
    }
    if (!aliasActiveAt(alias, event, ctx)) {
      return;
    }
    if (alias.access === "shared" && access === "shared") {
      return;
    }
    reportConflict({ attempted: place, access, existing: alias, event, ctx });
  });
};

const reportMutableCapabilityViolation = ({
  place,
  actor,
  event,
  ctx,
}: {
  place: BorrowPlace;
  actor?: SymbolId;
  event: Event;
  ctx: BodyContext;
}): void => {
  const binding =
    typeof actor === "number"
      ? ctx.symbolTable.getSymbol(actor).name
      : placeName(place, ctx);
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0050",
      params: {
        kind: "mutable-borrow-from-shared",
        binding,
      },
      span: event.span,
    }),
    ctx,
  );
};

const intrinsicNameForCall = (
  expr: HirExpression,
  ctx: BodyContext,
): string | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
  };
  return metadata.intrinsic
    ? (metadata.intrinsicName ?? record.name)
    : undefined;
};

const parameterAccessFor = ({
  index,
  actual,
  info,
  ctx,
}: {
  index: number;
  actual: HirExprId;
  info: ResolvedBorrowCall;
  ctx: BodyContext;
}): "owned" | "shared" | "mutable" => {
  const access = info.contract?.parameters[index]?.access;
  if (access) {
    return access === "shared" && !isReferenceLike(typeOfExpr(actual, ctx), ctx)
      ? "owned"
      : access;
  }
  const parameter = info.signature?.parameters[index];
  if (parameter?.bindingKind === "mutable-ref") {
    return "mutable";
  }
  return isReferenceLike(typeOfExpr(actual, ctx), ctx) ? "shared" : "owned";
};

const reportMutableEscape = ({
  symbol,
  span,
  through,
  ctx,
}: {
  symbol: SymbolId;
  span: SourceSpan;
  through: string;
  ctx: BodyContext;
}): void => {
  const alias = allAliases(ctx)
    .filter((candidate) => candidate.symbol === symbol)
    .at(-1);
  const binding = ctx.symbolTable.getSymbol(symbol).name;
  const declarationSpan =
    alias?.span ??
    (
      (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
        declarationSpan?: SourceSpan;
      }
    ).declarationSpan ??
    span;
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0049",
      params: { kind: "mutable-borrow-escape", binding, through },
      span,
      related: [
        diagnosticFromCode({
          code: "TY0049",
          params: { kind: "borrow-declaration", binding },
          span: declarationSpan,
          severity: "note",
        }),
      ],
    }),
    ctx,
  );
};

const escapedPlacesIn = (
  exprId: HirExprId,
  ctx: BodyContext,
): { symbol: SymbolId; alias: AliasDefinition }[] => {
  const symbols = new Set<SymbolId>();
  const captured: { symbol: SymbolId; alias: AliasDefinition }[] = [];
  const visitSymbol = (symbol: SymbolId, seen = new Set<SymbolId>()): void => {
    if (seen.has(symbol)) {
      return;
    }
    seen.add(symbol);
    symbols.add(symbol);
    ctx.closureCaptures
      .get(symbol)
      ?.forEach((capture) => visitSymbol(capture, seen));
  };
  function visitAtProjection(
    id: HirExprId,
    requested: readonly PlaceProjection[],
  ): void {
    if (requested.length === 0) {
      visit(id);
      return;
    }
    const expr = ctx.hir.expressions.get(id);
    if (!expr) {
      return;
    }
    if (expr.exprKind === "field-access") {
      visitAtProjection(expr.target, [
        { kind: "field", name: expr.field },
        ...requested,
      ]);
      return;
    }
    if (expr.exprKind === "object-literal") {
      const [projection, ...remaining] = requested;
      if (projection?.kind !== "field") {
        return;
      }
      const entry = expr.entries.find(
        (candidate) =>
          candidate.kind === "field" && candidate.name === projection.name,
      );
      if (entry) {
        visitAtProjection(entry.value, remaining);
      }
      return;
    }
    if (expr.exprKind === "tuple") {
      const [projection, ...remaining] = requested;
      if (projection?.kind !== "tuple") {
        return;
      }
      const element = expr.elements[projection.index];
      if (typeof element === "number") {
        visitAtProjection(element, remaining);
      }
      return;
    }
    if (expr.exprKind === "call" || expr.exprKind === "method-call") {
      const info = targetInfo(expr, ctx);
      info.contract?.parameters.forEach((parameter, index) => {
        if (!parameter.returned) {
          return;
        }
        const actual = info.arguments[index];
        if (typeof actual !== "number") {
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
          const translated = translateResultProjection({
            result: origin.result,
            source: origin.source,
            requested,
          });
          if (translated) {
            visitAtProjection(actual, translated);
          }
        });
      });
      return;
    }
    if (expr.exprKind === "identifier") {
      const initializer = ctx.bindingInitializers.get(expr.symbol);
      if (typeof initializer === "number") {
        visitAtProjection(initializer, requested);
      }
      return;
    }
    if (expr.exprKind === "block" && typeof expr.value === "number") {
      visitAtProjection(expr.value, requested);
      return;
    }
    if (expr.exprKind === "if" || expr.exprKind === "cond") {
      expr.branches.forEach((branch) =>
        visitAtProjection(branch.value, requested),
      );
      if (typeof expr.defaultBranch === "number") {
        visitAtProjection(expr.defaultBranch, requested);
      }
      return;
    }
    if (expr.exprKind === "match") {
      expr.arms.forEach((arm) => visitAtProjection(arm.value, requested));
      return;
    }
    if (expr.exprKind === "effect-handler") {
      visitAtProjection(expr.body, requested);
      expr.handlers.forEach((handler) =>
        visitAtProjection(handler.body, requested),
      );
      if (typeof expr.finallyBranch === "number") {
        visitAtProjection(expr.finallyBranch, requested);
      }
    }
  }
  function visit(id: HirExprId): void {
    const expr = ctx.hir.expressions.get(id);
    if (!expr) {
      return;
    }
    switch (expr.exprKind) {
      case "identifier":
        visitSymbol(expr.symbol);
        return;
      case "field-access":
        visitAtProjection(expr.target, [{ kind: "field", name: expr.field }]);
        return;
      case "tuple":
        expr.elements.forEach(visit);
        return;
      case "object-literal":
        expr.entries.forEach((entry) => visit(entry.value));
        return;
      case "lambda":
        {
          const event = ctx.events.get(expr.id);
          if (!event) {
            expr.captures.forEach((capture) => visitSymbol(capture.symbol));
            return;
          }
          lambdaCaptureOrigins(expr, event, ctx).forEach(
            ({ capture, place, source }) => {
              captured.push({
                symbol: capture.symbol,
                alias: {
                  ...(source ?? {
                    symbol: capture.symbol,
                    place,
                    access: "shared",
                    span: capture.span,
                    event,
                    uses: [event],
                  }),
                  access:
                    capture.mutable || source?.access === "mutable"
                      ? "mutable"
                      : "shared",
                  capture: true,
                },
              });
            },
          );
        }
        return;
      case "call":
      case "method-call": {
        const info = targetInfo(expr, ctx);
        info.contract?.parameters.forEach((parameter, index) => {
          if (!parameter.returned) {
            return;
          }
          const actual = info.arguments[index];
          if (typeof actual !== "number") {
            return;
          }
          const origins =
            parameter.returnedOrigins && parameter.returnedOrigins.length > 0
              ? parameter.returnedOrigins
              : (parameter.returnedPaths && parameter.returnedPaths.length > 0
                  ? parameter.returnedPaths
                  : [[]]
                ).map((source) => ({ source, result: [] }));
          origins.forEach((origin) => visitAtProjection(actual, origin.source));
        });
        return;
      }
      case "block":
        if (typeof expr.value === "number") {
          visit(expr.value);
        }
        return;
      case "if":
      case "cond":
        expr.branches.forEach((branch) => visit(branch.value));
        if (typeof expr.defaultBranch === "number") {
          visit(expr.defaultBranch);
        }
        return;
      case "match":
        expr.arms.forEach((arm) => visit(arm.value));
        return;
      case "effect-handler":
        visit(expr.body);
        expr.handlers.forEach((handler) => visit(handler.body));
        if (typeof expr.finallyBranch === "number") {
          visit(expr.finallyBranch);
        }
        return;
      default:
        return;
    }
  }
  visit(exprId);
  return [
    ...captured,
    ...Array.from(symbols).flatMap((symbol) => {
      const event = ctx.events.get(exprId);
      const aliases = event
        ? reachingAliasDefinitions(symbol, event, ctx)
        : [ctx.aliases.get(symbol)].filter(
            (alias): alias is AliasDefinition => alias !== undefined,
          );
      return aliases.map((alias) => ({ symbol, alias }));
    }),
  ];
};

const escapeExpression = ({
  exprId,
  span,
  through,
  projectionPaths = [[]],
  downgradeCapability = true,
  ctx,
}: {
  exprId: HirExprId;
  span: SourceSpan;
  through: string;
  projectionPaths?: readonly (readonly PlaceProjection[])[];
  downgradeCapability?: boolean;
  ctx: BodyContext;
}): void => {
  const event = ctx.events.get(exprId) ?? {
    position: ctx.nextPosition,
    span,
    path: new Map(),
    loops: new Set(),
  };
  const escapedAliases = new Set<SymbolId>();
  escapedPlacesIn(exprId, ctx).forEach(({ symbol, alias }) => {
    const selectedPlaces = projectionPaths.flatMap((path) => {
      if (alias.conservativeReturnedAggregate) {
        return [alias.place];
      }
      if (!alias.resultProjections) {
        return [path.reduce(appendProjection, alias.place)];
      }
      const translated = translateResultProjection({
        result: alias.resultProjections,
        source: [],
        requested: path,
      });
      return translated
        ? [translated.reduce(appendProjection, alias.place)]
        : [];
    });
    if (selectedPlaces.length === 0) {
      return;
    }
    escapedAliases.add(symbol);
    if (alias.access === "mutable") {
      reportMutableEscape({ symbol, span, through, ctx });
      return;
    }
    if (!downgradeCapability) {
      return;
    }
    selectedPlaces.forEach((place) => {
      if (!activeDowngradeFor(place, event, ctx)) {
        ctx.downgraded.push({ place, span, event });
        ctx.facts.push({
          kind: "capability-downgrade",
          place,
          span,
        });
      }
    });
  });
  if (!downgradeCapability) {
    return;
  }
  const places = uniquePlaces(
    projectionPaths.flatMap((path) =>
      placesAtProjection(exprId, path, ctx, new Set()),
    ),
  );
  const owner = baseSymbolOf(exprId, ctx);
  const initializer =
    typeof owner === "number" ? ctx.bindingInitializers.get(owner) : undefined;
  const escapedType =
    typeOfExpr(exprId, ctx) ??
    (typeof initializer === "number"
      ? typeOfExpr(initializer, ctx)
      : undefined);
  if (
    places.length === 0 ||
    typeof escapedType !== "number" ||
    !isReferenceLike(escapedType, ctx)
  ) {
    return;
  }
  places
    .filter(
      (place) =>
        ctx.mutableOwners.has(place.root) && !escapedAliases.has(place.root),
    )
    .forEach((place) => {
      if (activeDowngradeFor(place, event, ctx)) {
        return;
      }
      ctx.downgraded.push({ place, span, event });
      ctx.facts.push({
        kind: "capability-downgrade",
        place,
        span,
      });
    });
};

const escapeImplicitReturnValues = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): void => {
  if (seen.has(exprId)) {
    return;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || !expressionCanFallThrough(exprId, ctx.hir)) {
    return;
  }
  if (expr.exprKind === "block") {
    if (typeof expr.value === "number") {
      escapeImplicitReturnValues(expr.value, ctx, seen);
    }
    return;
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    expr.branches.forEach((branch) =>
      escapeImplicitReturnValues(branch.value, ctx, new Set(seen)),
    );
    if (typeof expr.defaultBranch === "number") {
      escapeImplicitReturnValues(expr.defaultBranch, ctx, new Set(seen));
    }
    return;
  }
  if (expr.exprKind === "match") {
    expr.arms.forEach((arm) =>
      escapeImplicitReturnValues(arm.value, ctx, new Set(seen)),
    );
    return;
  }
  if (expr.exprKind === "effect-handler") {
    escapeImplicitReturnValues(expr.body, ctx, new Set(seen));
    expr.handlers.forEach((handler) =>
      escapeImplicitReturnValues(handler.body, ctx, new Set(seen)),
    );
    if (typeof expr.finallyBranch === "number") {
      escapeImplicitReturnValues(expr.finallyBranch, ctx, new Set(seen));
    }
    return;
  }
  escapeExpression({
    exprId,
    span: expr.span,
    through: "this return",
    downgradeCapability: false,
    ctx,
  });
};

const validateCall = (
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  event: Event,
  ctx: BodyContext,
): void => {
  const intrinsicName = intrinsicNameForCall(expr, ctx);
  if (intrinsicName === "~") {
    return;
  }
  const info = targetInfo(expr, ctx);
  const actuals = info.arguments;
  const effectiveActuals = (
    info.contract?.parameters ?? actuals.map(() => undefined)
  ).flatMap((parameter, index) => {
    const actual = actuals[index];
    if (typeof actual === "number") {
      return [{ index, actual }];
    }
    return (parameter?.defaultOrigins ?? []).flatMap((origin) => {
      const defaultActual = actuals[origin];
      return typeof defaultActual === "number"
        ? [{ index, actual: defaultActual }]
        : [];
    });
  });
  validateBorrowedCallbacks(expr, info, ctx);
  const borrows = effectiveActuals.flatMap(({ actual, index }) => {
    const access = parameterAccessFor({ index, actual, info, ctx });
    if (access === "owned") {
      return [];
    }
    const actor = baseSymbolOf(actual, ctx);
    return placesOfExpression(actual, ctx).map((place) => {
      if (
        access === "mutable" &&
        (typeof actor === "number"
          ? !hasMutableCapabilityAt(actor, event, ctx)
          : !isSharedCellValueExpression(actual, ctx))
      ) {
        reportMutableCapabilityViolation({ place, actor, event, ctx });
      }
      checkAccess({ place, actor, access, event, ctx });
      ctx.facts.push({
        kind: "call-borrow",
        expr: expr.id,
        place,
        access,
      });
      return { index, actual, place, actor, access };
    });
  });

  borrows.forEach((left, index) => {
    borrows.slice(index + 1).forEach((right) => {
      if (!placeOverlaps(left.place, right.place)) {
        return;
      }
      if (left.access === "shared" && right.access === "shared") {
        return;
      }
      const synthetic: AliasDefinition = {
        symbol: left.actor ?? left.place.root,
        place: left.place,
        access: left.access,
        span: ctx.hir.expressions.get(left.actual)?.span ?? event.span,
        event,
        uses: [event],
      };
      reportConflict({
        attempted: right.place,
        access: right.access,
        existing: synthetic,
        event: ctx.events.get(right.actual) ?? event,
        ctx,
      });
    });
  });

  effectiveActuals.forEach(({ actual, index }) => {
    if (info.contract?.parameters[index]?.retained !== true) {
      return;
    }
    escapeExpression({
      exprId: actual,
      span: event.span,
      through: "a retaining call",
      projectionPaths:
        info.contract.parameters[index]?.retainedPaths &&
        info.contract.parameters[index]!.retainedPaths!.length > 0
          ? info.contract.parameters[index]!.retainedPaths
          : undefined,
      ctx,
    });
  });

  if (!callMaySuspend(info, ctx)) {
    return;
  }
  const activeMutable = [
    ...allAliases(ctx).filter(
      (alias) => alias.access === "mutable" && aliasActiveAt(alias, event, ctx),
    ),
    ...Array.from(ctx.mutableParameters).map((symbol) => ({
      symbol,
      place: ctx.places.get(symbol) ?? { root: symbol, projections: [] },
      access: "mutable" as const,
      span:
        (
          (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
            declarationSpan?: SourceSpan;
          }
        ).declarationSpan ?? event.span,
      event,
      uses: [event],
    })),
  ][0];
  const mutableCallBorrow = borrows.find(
    (borrow) => borrow.access === "mutable",
  );
  const borrow =
    activeMutable ??
    (mutableCallBorrow
      ? {
          symbol: mutableCallBorrow.actor ?? mutableCallBorrow.place.root,
          place: mutableCallBorrow.place,
          span:
            ctx.hir.expressions.get(mutableCallBorrow.actual)?.span ??
            event.span,
        }
      : undefined);
  if (!borrow) {
    return;
  }
  const binding = placeName(borrow.place, ctx);
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0052",
      params: { kind: "borrow-across-effect", binding },
      span: event.span,
      related: [
        diagnosticFromCode({
          code: "TY0052",
          params: { kind: "borrow-origin", binding },
          span: borrow.span,
          severity: "note",
        }),
      ],
    }),
    ctx,
  );
};

const callMaySuspend = (
  info: ResolvedBorrowCall,
  ctx: BodyContext,
): boolean => {
  if (info.contract) {
    return info.contract.maySuspend;
  }
  const target = info.target;
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
  const effectRow = info.signature?.effectRow;
  return (
    typeof effectRow === "number" && !ctx.typing.effects.isEmpty(effectRow)
  );
};

type CallableValueResolution =
  | { kind: "known"; contract: CallableBorrowContract }
  | { kind: "deferred" }
  | { kind: "unknown" };

const mergeCallableValueResolutions = (
  resolutions: readonly CallableValueResolution[],
): CallableValueResolution => {
  if (resolutions.some((resolution) => resolution.kind === "unknown")) {
    return { kind: "unknown" };
  }
  const contracts = resolutions.flatMap((resolution) =>
    resolution.kind === "known" ? [resolution.contract] : [],
  );
  const merged = mergeCallableBorrowContracts(contracts);
  if (resolutions.some((resolution) => resolution.kind === "deferred")) {
    return merged ? { kind: "known", contract: merged } : { kind: "deferred" };
  }
  return merged ? { kind: "known", contract: merged } : { kind: "unknown" };
};

const callableValueAtPath = (
  exprId: HirExprId,
  ctx: BodyContext,
  path: readonly string[] = [],
  seen = new Set<HirExprId>(),
): CallableValueResolution => {
  if (seen.has(exprId)) {
    return { kind: "unknown" };
  }
  seen.add(exprId);
  const callback = ctx.hir.expressions.get(exprId);
  if (!callback) {
    return { kind: "unknown" };
  }
  if (callback.exprKind === "identifier") {
    const imported = ctx.imports.get(callback.symbol);
    const direct = imported
      ? ctx.dependencies.get(imported.moduleId)?.callables.get(imported.symbol)
          ?.contract
      : ctx.contracts.get(callback.symbol);
    if (path.length === 0 && direct) {
      return { kind: "known", contract: direct };
    }
    if (ctx.unknownCallableBindings.has(callback.symbol)) {
      return { kind: "unknown" };
    }
    const initializer = ctx.bindingInitializers.get(callback.symbol);
    if (typeof initializer === "number") {
      return callableValueAtPath(initializer, ctx, path, seen);
    }
    return ctx.parameterSymbols.has(callback.symbol)
      ? { kind: "deferred" }
      : { kind: "unknown" };
  }
  if (callback.exprKind === "call" || callback.exprKind === "method-call") {
    const resolved = targetInfo(callback, ctx);
    const returned =
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
          const translated = translateResultProjection({
            result: origin.result,
            source: origin.source,
            requested: path.map((name) => ({
              kind: "field" as const,
              name,
            })),
          });
          return translated
            ? [
                {
                  actual,
                  path: translated.flatMap((projection) =>
                    projection.kind === "field"
                      ? [projection.name]
                      : projection.kind === "tuple"
                        ? [String(projection.index)]
                        : [],
                  ),
                },
              ]
            : [];
        });
      }) ?? [];
    return returned.length > 0
      ? mergeCallableValueResolutions(
          returned.map((origin) =>
            callableValueAtPath(origin.actual, ctx, origin.path, new Set(seen)),
          ),
        )
      : { kind: "unknown" };
  }
  if (path.length > 0) {
    if (callback.exprKind !== "object-literal") {
      return { kind: "unknown" };
    }
    const [field, ...remaining] = path;
    const entry = callback.entries.find(
      (candidate) => candidate.kind === "field" && candidate.name === field,
    );
    return entry
      ? callableValueAtPath(entry.value, ctx, remaining, seen)
      : { kind: "unknown" };
  }
  if (callback?.exprKind === "lambda") {
    return {
      kind: "known",
      contract: summarizeLambdaBorrowing({
        lambda: callback,
        hir: ctx.hir,
        typing: ctx.typing,
        symbolTable: ctx.symbolTable,
        moduleId: ctx.moduleId,
        imports: ctx.imports,
        dependencies: ctx.dependencies,
        contracts: ctx.contracts,
        decls: ctx.decls,
      }),
    };
  }
  if (callback.exprKind === "field-access") {
    return callableValueAtPath(callback.target, ctx, [callback.field], seen);
  }
  if (callback.exprKind === "if" || callback.exprKind === "cond") {
    return mergeCallableValueResolutions([
      ...callback.branches.map((branch) =>
        callableValueAtPath(branch.value, ctx, [], new Set(seen)),
      ),
      ...(typeof callback.defaultBranch === "number"
        ? [callableValueAtPath(callback.defaultBranch, ctx, [], new Set(seen))]
        : [{ kind: "unknown" as const }]),
    ]);
  }
  if (callback.exprKind === "match") {
    return mergeCallableValueResolutions(
      callback.arms.map((arm) =>
        callableValueAtPath(arm.value, ctx, [], new Set(seen)),
      ),
    );
  }
  if (callback.exprKind === "block" && typeof callback.value === "number") {
    return callableValueAtPath(callback.value, ctx, [], seen);
  }
  return { kind: "unknown" };
};

const validateBorrowedCallbacks = (
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  info: ResolvedBorrowCall,
  ctx: BodyContext,
): void => {
  info.contract?.scopedCallbacks?.forEach((scoped) => {
    const callbackExpr = info.arguments[scoped.callbackParameter];
    if (typeof callbackExpr !== "number") {
      return;
    }
    const resolution = callableValueAtPath(
      callbackExpr,
      ctx,
      scoped.callbackPath,
    );
    if (resolution.kind === "deferred") {
      return;
    }
    const borrowed =
      resolution.kind === "known"
        ? resolution.contract.parameters[scoped.callbackValueParameter]
        : undefined;
    const unknown = resolution.kind === "unknown";
    if (!unknown && !borrowed?.retained && !borrowed?.returned) {
      return;
    }
    const callback = ctx.hir.expressions.get(callbackExpr);
    const parameter =
      callback?.exprKind === "lambda"
        ? callback.parameters[scoped.callbackValueParameter]
        : undefined;
    const symbol =
      parameter?.pattern.kind === "identifier"
        ? parameter.pattern.symbol
        : undefined;
    const binding =
      typeof symbol === "number"
        ? ctx.symbolTable.getSymbol(symbol).name
        : "value";
    const origin = parameter?.span ?? callback?.span ?? expr.span;
    addDiagnostic(
      diagnosticFromCode({
        code: "TY0053",
        params: {
          kind: "borrowed-callback-escape",
          binding,
          through: borrowed?.returned
            ? "the callback return"
            : unknown
              ? "an opaque callback"
              : "the callback",
        },
        span: callback?.span ?? expr.span,
        related: [
          diagnosticFromCode({
            code: "TY0053",
            params: { kind: "borrow-origin", binding },
            span: origin,
            severity: "note",
          }),
        ],
      }),
      ctx,
    );
  });
};

const validateExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  suppressTerminalAccess = false,
): void => {
  const expr = ctx.hir.expressions.get(exprId);
  const event = ctx.events.get(exprId);
  if (!expr || !event) {
    return;
  }
  switch (expr.exprKind) {
    case "literal":
    case "overload-set":
    case "continue":
      return;
    case "identifier": {
      if (suppressTerminalAccess) {
        return;
      }
      placesOfExpression(expr.id, ctx).forEach((place) => {
        checkAccess({
          place,
          actor: expr.symbol,
          access: "shared",
          event,
          ctx,
        });
      });
      return;
    }
    case "field-access": {
      validateExpression(expr.target, ctx, true);
      if (!suppressTerminalAccess) {
        placesOfExpression(expr.id, ctx).forEach((place) => {
          checkAccess({
            place,
            actor: baseSymbolOf(expr.id, ctx),
            access: "shared",
            event,
            ctx,
          });
        });
      }
      return;
    }
    case "tuple":
      expr.elements.forEach((element) => validateExpression(element, ctx));
      return;
    case "object-literal":
      expr.entries.forEach((entry) => validateExpression(entry.value, ctx));
      return;
    case "call":
      validateExpression(expr.callee, ctx, true);
      expr.args.forEach((arg) => validateExpression(arg.expr, ctx, true));
      validateCall(expr, event, ctx);
      return;
    case "method-call":
      validateExpression(expr.target, ctx, true);
      expr.args.forEach((arg) => validateExpression(arg.expr, ctx, true));
      validateCall(expr, event, ctx);
      return;
    case "block": {
      let fallsThrough = true;
      for (const statementId of expr.statements) {
        const statement = ctx.hir.statements.get(statementId);
        if (!statement) {
          continue;
        }
        if (statement.kind === "let") {
          const symbols = patternSymbols(statement.pattern);
          const createsAlias = symbols.some((symbol) =>
            allAliases(ctx).some((alias) => alias.symbol === symbol),
          );
          validateExpression(statement.initializer, ctx, createsAlias);
          symbols.forEach((symbol) => {
            const aliases = allAliases(ctx).filter(
              (alias) =>
                alias.symbol === symbol &&
                alias.event.span.start === statement.span.start,
            );
            if (aliases.length === 0) {
              return;
            }
            aliases.forEach((alias) => {
              if (alias.access === "mutable" && alias.capture !== true) {
                const sourceActor = baseSymbolOf(statement.initializer, ctx);
                const sourceMutable =
                  sourceActor !== undefined &&
                  ctx.mutableOwners.has(sourceActor);
                const downgraded = activeDowngradeFor(
                  alias.place,
                  alias.event,
                  ctx,
                );
                if (!sourceMutable || downgraded) {
                  const binding =
                    sourceActor !== undefined
                      ? ctx.symbolTable.getSymbol(sourceActor).name
                      : placeName(alias.place, ctx);
                  addDiagnostic(
                    diagnosticFromCode({
                      code: "TY0050",
                      params: {
                        kind: "mutable-borrow-from-shared",
                        binding,
                      },
                      span: statement.span,
                    }),
                    ctx,
                  );
                }
              }
              checkAccess({
                place: alias.place,
                actor: symbol,
                access: alias.access,
                event: alias.event,
                ctx,
              });
            });
          });
          fallsThrough = expressionCanFallThrough(
            statement.initializer,
            ctx.hir,
          );
          if (!fallsThrough) {
            break;
          }
          continue;
        }
        if (statement.kind === "return") {
          if (typeof statement.value === "number") {
            validateExpression(statement.value, ctx);
            escapeExpression({
              exprId: statement.value,
              span: statement.span,
              through: "this return",
              downgradeCapability: false,
              ctx,
            });
          }
          fallsThrough = false;
          break;
        }
        validateExpression(statement.expr, ctx);
        fallsThrough = expressionCanFallThrough(statement.expr, ctx.hir);
        if (!fallsThrough) {
          break;
        }
      }
      if (fallsThrough && typeof expr.value === "number") {
        validateExpression(expr.value, ctx);
      }
      return;
    }
    case "if":
    case "cond":
      expr.branches.forEach((branch) => {
        validateExpression(branch.condition, ctx);
        validateExpression(branch.value, ctx);
      });
      if (typeof expr.defaultBranch === "number") {
        validateExpression(expr.defaultBranch, ctx);
      }
      return;
    case "match":
      validateExpression(expr.discriminant, ctx);
      expr.arms.forEach((arm) => {
        if (typeof arm.guard === "number") {
          validateExpression(arm.guard, ctx);
        }
        validateExpression(arm.value, ctx);
      });
      return;
    case "loop":
      validateExpression(expr.body, ctx);
      return;
    case "while":
      validateExpression(expr.condition, ctx);
      validateExpression(expr.body, ctx);
      return;
    case "lambda":
      lambdaCaptureOrigins(expr, event, ctx).forEach(({ capture, source }) => {
        if (
          source?.access === "mutable" ||
          ctx.mutableParameters.has(capture.symbol)
        ) {
          reportMutableEscape({
            symbol: capture.symbol,
            span: expr.span,
            through: "a closure capture",
            ctx,
          });
        }
      });
      return;
    case "effect-handler":
      validateExpression(expr.body, ctx);
      expr.handlers.forEach((handler) => validateExpression(handler.body, ctx));
      if (typeof expr.finallyBranch === "number") {
        validateExpression(expr.finallyBranch, ctx);
      }
      return;
    case "assign": {
      if (typeof expr.target === "number") {
        validateExpression(expr.target, ctx, true);
      }
      validateExpression(expr.value, ctx);
      if (typeof expr.target === "number") {
        const targetId = expr.target;
        const target = ctx.hir.expressions.get(targetId);
        if (target?.exprKind === "identifier") {
          return;
        }
        const actor = baseSymbolOf(targetId, ctx);
        placesOfExpression(targetId, ctx).forEach((place) => {
          if (
            typeof actor === "number" &&
            !hasMutableCapabilityAt(actor, event, ctx)
          ) {
            reportMutableCapabilityViolation({ place, actor, event, ctx });
          }
          checkAccess({
            place,
            actor,
            access: "mutable",
            event,
            ctx,
          });
        });
        if (target?.exprKind === "field-access") {
          escapeExpression({
            exprId: expr.value,
            span: expr.span,
            through: "field storage",
            ctx,
          });
        }
      }
      return;
    }
    case "break":
      if (typeof expr.value === "number") {
        validateExpression(expr.value, ctx);
      }
      return;
  }
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

const initializeCallableContext = ({
  callable,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  facts,
  diagnostics,
}: {
  callable: BorrowCallable;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  facts: BorrowFact[];
  diagnostics: Diagnostic[];
}): BodyContext => {
  const places = new Map<SymbolId, BorrowPlace>();
  const mutableOwners = new Set<SymbolId>();
  const mutableParameters = new Set<SymbolId>();
  callable.parameters.forEach((parameter) => {
    patternSymbols(parameter.pattern).forEach((symbol) => {
      places.set(symbol, { root: symbol, projections: [] });
      if (parameter.pattern.bindingKind === "mutable-ref") {
        mutableOwners.add(symbol);
        mutableParameters.add(symbol);
      }
    });
  });
  callable.captures?.forEach((capture) => {
    places.set(capture.symbol, {
      root: capture.symbol,
      projections: [],
    });
    if (capture.mutable) {
      mutableOwners.add(capture.symbol);
    }
  });
  return {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    aliases: new Map(),
    assignmentAliases: [],
    reassignments: [],
    places,
    mutableOwners,
    events: new Map(),
    uses: new Map(),
    facts,
    diagnostics,
    downgraded: [],
    terminations: [],
    mutableParameters,
    closureCaptures: new Map(),
    bindingInitializers: new Map(),
    unknownCallableBindings: new Set(),
    parameterSymbols: new Set(
      callable.parameters.flatMap((parameter) =>
        patternSymbols(parameter.pattern),
      ),
    ),
    nextPosition: 0,
    nextBranch: 0,
  };
};

const validateReferenceDefaults = ({
  callable,
  contract,
  ctx,
}: {
  callable: BorrowCallable;
  contract?: CallableBorrowContract;
  ctx: BodyContext;
}): void => {
  callable.parameters.forEach((parameter, index) => {
    const origins = contract?.parameters[index]?.defaultOrigins ?? [];
    if (origins.length === 0) {
      return;
    }
    origins.forEach((sourceIndex) => {
      const sourceParameter = callable.parameters[sourceIndex];
      if (
        !sourceParameter ||
        (sourceParameter.pattern.bindingKind !== "mutable-ref" &&
          parameter.pattern.bindingKind !== "mutable-ref")
      ) {
        return;
      }
      const sourceSymbol = patternSymbols(sourceParameter.pattern)[0];
      const sourceName =
        typeof sourceSymbol === "number"
          ? ctx.symbolTable.getSymbol(sourceSymbol).name
          : `parameter ${sourceIndex + 1}`;
      addDiagnostic(
        diagnosticFromCode({
          code: "TY0048",
          params: {
            kind: "borrow-conflict",
            access:
              parameter.pattern.bindingKind === "mutable-ref"
                ? "mutably borrow"
                : "read",
            place: sourceName,
            existing:
              sourceParameter.pattern.bindingKind === "mutable-ref"
                ? "mutable"
                : "shared",
          },
          span: parameter.span,
          related: [
            diagnosticFromCode({
              code: "TY0048",
              params: {
                kind: "borrow-origin",
                borrow:
                  sourceParameter.pattern.bindingKind === "mutable-ref"
                    ? "mutable"
                    : "shared",
                place: sourceName,
              },
              span: sourceParameter.span,
              severity: "note",
            }),
          ],
        }),
        ctx,
      );
    });
  });
};

export const analyzeFunctionBorrowing = ({
  functionItem,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  facts,
  diagnostics,
}: {
  functionItem: HirFunction;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  facts: BorrowFact[];
  diagnostics: Diagnostic[];
}): void => {
  analyzeCallableBorrowing({
    callable: functionItem,
    contract: contracts.get(functionItem.symbol),
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    facts,
    diagnostics,
  });
};

export const analyzeLambdaBodyBorrowing = ({
  lambda,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  facts,
  diagnostics,
}: {
  lambda: HirLambdaExpr;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  facts: BorrowFact[];
  diagnostics: Diagnostic[];
}): void => {
  analyzeCallableBorrowing({
    callable: lambda,
    contract: summarizeLambdaBorrowing({
      lambda,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports,
      dependencies,
      contracts,
      decls,
    }),
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    facts,
    diagnostics,
  });
};

const analyzeCallableBorrowing = ({
  callable,
  contract,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  facts,
  diagnostics,
}: {
  callable: BorrowCallable;
  contract?: CallableBorrowContract;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  facts: BorrowFact[];
  diagnostics: Diagnostic[];
}): void => {
  const ctx = initializeCallableContext({
    callable,
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    facts,
    diagnostics,
  });
  validateReferenceDefaults({ callable, contract, ctx });
  callable.parameters.forEach((parameter) => {
    if (typeof parameter.defaultValue !== "number") {
      return;
    }
    scanExpression(
      parameter.defaultValue,
      { path: new Map(), loops: new Set() },
      ctx,
    );
  });
  scanExpression(callable.body, { path: new Map(), loops: new Set() }, ctx);
  ctx.closureCaptures.forEach((captures, closure) => {
    const closureUses = ctx.uses.get(closure) ?? [];
    const pending = [...captures];
    const seen = new Set<SymbolId>();
    while (pending.length > 0) {
      const capture = pending.pop()!;
      if (seen.has(capture)) {
        continue;
      }
      seen.add(capture);
      pending.push(...(ctx.closureCaptures.get(capture) ?? []));
      if (closureUses.length === 0) {
        continue;
      }
      const uses = ctx.uses.get(capture) ?? [];
      uses.push(...closureUses);
      uses.sort((left, right) => left.position - right.position);
      ctx.uses.set(capture, uses);
    }
  });
  allAliases(ctx).forEach((alias) => {
    const symbol = alias.symbol;
    const uses = ctx.uses.get(symbol) ?? [];
    alias.uses = uses.filter(
      (use) =>
        use.position >= alias.event.position ||
        definitionCanReachOnLoopBackedge(alias.event, use, ctx),
    );
    facts.push({
      kind: "alias",
      symbol,
      place: alias.place,
      access: alias.access,
      span: alias.span,
      lastUse: uses.at(-1)?.span,
    });
  });
  callable.parameters.forEach((parameter) => {
    if (typeof parameter.defaultValue === "number") {
      validateExpression(parameter.defaultValue, ctx);
    }
  });
  validateExpression(callable.body, ctx);
  escapeImplicitReturnValues(callable.body, ctx);

  contract?.parameters.forEach((parameter, index) => {
    if (!parameter.retained && !parameter.returned) {
      return;
    }
    const symbols = callable.parameters[index]
      ? patternSymbols(callable.parameters[index]!.pattern)
      : [];
    symbols.forEach((symbol) => {
      if (!ctx.mutableParameters.has(symbol)) {
        return;
      }
      reportMutableEscape({
        symbol,
        span: callable.span,
        through: "the callable boundary",
        ctx,
      });
    });
  });
};
