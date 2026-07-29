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
import { walkExpression } from "../hir/index.js";
import type {
  HirExprId,
  ScopeId,
  SourceSpan,
  SymbolId,
  TypeId,
} from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import type {
  BorrowPlace,
  CallableBorrowContract,
  CallableParameterBorrowContract,
  PlaceProjection,
  ReturnedBorrowOrigin,
} from "./model.js";
import {
  mergeCallableBorrowContracts,
  projectionPathCovers,
  projectionPathsOverlap,
  translateProjectionPath,
} from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import {
  materializedObjectReferencePaths,
  projectedTypes,
  resolveBorrowCall,
  type ResolvedBorrowCall,
} from "./call-resolution.js";
import { summarizeLambdaBorrowing } from "./summaries.js";
import { expressionCanFallThrough } from "./control-flow.js";
import {
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";
import {
  borrowedPathsInType,
  borrowedTypeEntriesInType,
  type BorrowedTypeEntry,
  typeContainsBorrowed,
  typeParameterPathsInType,
} from "./borrowed-types.js";
import { objectLiteralFieldProvider } from "./object-literal-providers.js";

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
  provenance: "allocation-alias" | "storage-borrow";
  span: SourceSpan;
  event: Event;
  uses: readonly Event[];
  conservativeReturnedAggregate?: boolean;
  resultProjections?: readonly PlaceProjection[];
  capture?: boolean;
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
  usePlaces: Map<SymbolId, Map<Event, readonly BorrowPlace[]>>;
  mutableStorageSymbols: Set<SymbolId>;
  diagnostics: Diagnostic[];
  terminations: Termination[];
  mutableParameters: ReadonlySet<SymbolId>;
  closureCaptures: Map<SymbolId, readonly SymbolId[]>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  callResolutionCache: Map<HirExprId, ResolvedBorrowCall>;
  unknownCallableBindings: Set<SymbolId>;
  parameterSymbols: Set<SymbolId>;
  borrowedParameterSymbols: Set<SymbolId>;
  borrowedReturnEntries: readonly BorrowedTypeEntry[];
  borrowedReturnPaths: readonly (readonly PlaceProjection[])[];
  returnType: TypeId | undefined;
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
  suppressUse?: boolean;
};

const cloneScanContext = (
  ctx: ScanContext,
  overrides?: Partial<ScanContext>,
): ScanContext => ({
  path: new Map(overrides?.path ?? ctx.path),
  loops: new Set(overrides?.loops ?? ctx.loops),
  suppressPlaceAccess:
    overrides?.suppressPlaceAccess ?? ctx.suppressPlaceAccess,
  suppressUse: overrides?.suppressUse ?? ctx.suppressUse,
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

const borrowedEndpointIsDereferenced = (
  inner: TypeId,
  typing: TypingResult,
): boolean =>
  typing.arena.get(inner).kind !== "type-param-ref" &&
  typeIsAllocationBacked(inner, typing);

const expressionMaterializesBorrowedPrimitive = (
  exprId: HirExprId,
  expectedTypes: readonly (TypeId | undefined)[],
  ctx: Pick<BodyContext, "hir" | "typing">,
): boolean => {
  const expression = ctx.hir.expressions.get(exprId);
  const actualType =
    expression?.exprKind === "identifier"
      ? (ctx.typing.valueTypes.get(expression.symbol) ??
        typeOfExpr(exprId, ctx))
      : typeOfExpr(exprId, ctx);
  if (typeof actualType !== "number") {
    return false;
  }
  const descriptor = ctx.typing.arena.get(actualType);
  return (
    descriptor.kind === "borrowed" &&
    ctx.typing.arena.get(descriptor.inner).kind === "primitive" &&
    expectedTypes.length > 0 &&
    expectedTypes.every((expected) => expected === descriptor.inner)
  );
};

const aggregateProjectionMaterializesBorrowedPrimitive = (
  aggregate: HirExprId,
  value: HirExprId,
  projection: PlaceProjection,
  ctx: Pick<BodyContext, "hir" | "typing">,
): boolean => {
  const aggregateType = typeOfExpr(aggregate, ctx);
  return (
    typeof aggregateType === "number" &&
    expressionMaterializesBorrowedPrimitive(
      value,
      projectedTypes(aggregateType, [projection], ctx.typing),
      ctx,
    )
  );
};

const isCallableType = (
  typeId: TypeId | undefined,
  ctx: Pick<BodyContext, "typing">,
  seen = new Set<TypeId>(),
): boolean => {
  if (typeof typeId !== "number" || seen.has(typeId)) {
    return false;
  }
  seen.add(typeId);
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind === "function") {
    return true;
  }
  if (descriptor.kind === "intersection") {
    return [descriptor.nominal, descriptor.structural].some((member) =>
      isCallableType(member, ctx, new Set(seen)),
    );
  }
  if (descriptor.kind === "union") {
    return descriptor.members.some((member) =>
      isCallableType(member, ctx, new Set(seen)),
    );
  }
  if (descriptor.kind === "recursive") {
    return isCallableType(descriptor.body, ctx, seen);
  }
  return false;
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
  if (expr.exprKind === "identifier" && scan.suppressUse !== true) {
    recordExpressionUse(expr.id, event, undefined, ctx);
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

const accessProjectionsFor = (
  exprId: HirExprId,
  projection: PlaceProjection,
  ctx: BodyContext,
): readonly PlaceProjection[] => {
  const type = typeOfExpr(exprId, ctx);
  const expression = ctx.hir.expressions.get(exprId);
  const isExplicitBorrow =
    typeof type === "number" && ctx.typing.arena.get(type).kind === "borrowed";
  return typeof type === "number" &&
    typeIsAllocationBacked(type, ctx.typing) &&
    !isExplicitBorrow &&
    expression?.exprKind !== "identifier"
    ? [{ kind: "dereference" }, projection]
    : [projection];
};

const appendAccessProjections = (
  place: BorrowPlace,
  projections: readonly PlaceProjection[],
): BorrowPlace =>
  projections.reduce((result, projection) => {
    if (
      projection.kind === "dereference" &&
      result.projections.at(-1)?.kind === "dereference"
    ) {
      return result;
    }
    return appendProjection(result, projection);
  }, place);

const applyBorrowEndpoint = (
  place: BorrowPlace,
  endpointAccess: ReturnedBorrowOrigin["endpointAccess"],
): BorrowPlace =>
  endpointAccess === "dereferenced"
    ? appendAccessProjections(place, [{ kind: "dereference" }])
    : place;

const appendExpressionAccess = (
  place: BorrowPlace,
  exprId: HirExprId,
  projections: readonly PlaceProjection[],
  ctx: BodyContext,
): BorrowPlace => {
  const type = typeOfExpr(exprId, ctx);
  const expression = ctx.hir.expressions.get(exprId);
  const needsDereference =
    expression?.exprKind === "identifier" &&
    typeof type === "number" &&
    typeIsAllocationBacked(type, ctx.typing) &&
    place.projections.length > 0;
  return appendAccessProjections(
    place,
    needsDereference ? [{ kind: "dereference" }, ...projections] : projections,
  );
};

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

const transferDestinationIsLocal = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const symbol = baseSymbolOf(exprId, ctx);
  if (typeof symbol !== "number") {
    return false;
  }
  const place = ctx.places.get(symbol);
  const root = place?.root ?? symbol;
  if (ctx.parameterSymbols.has(root)) {
    return false;
  }
  const record = ctx.symbolTable.getSymbol(root);
  return ctx.symbolTable.getScope(record.scope).kind !== "module";
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
    const ownPlace = ctx.places.get(expr.symbol);
    if (
      ownPlace?.root === expr.symbol &&
      ownPlace.projections.length === 0 &&
      isAggregateExpression(expr.id, ctx)
    ) {
      return [ownPlace];
    }
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
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    const accessProjections = accessProjectionsFor(
      expr.target,
      projection,
      ctx,
    );
    const returned = projectedReturnedPlaces(
      expr.target,
      accessProjections,
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
          appendExpressionAccess(target, expr.target, accessProjections, ctx),
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
    ]);
  }
  if (
    expr.exprKind === "method-call" &&
    expr.method === "subscript_get" &&
    expr.args[0]
  ) {
    const targets = placesOfExpression(expr.target, ctx, seen);
    const projections = accessProjectionsFor(
      expr.target,
      {
        kind: "index",
        constant: numericConstant(expr.args[0]!.expr, ctx),
        stable: hasStableIndexedStorage(expr.target, ctx),
      },
      ctx,
    );
    return hasConservativeReturnedAggregate(expr.target, ctx)
      ? targets
      : targets.map((target) =>
          appendExpressionAccess(target, expr.target, projections, ctx),
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

const specializedReturnedEndpoint = (
  info: ResolvedBorrowCall,
  parameterIndex: number,
  origin: ReturnedBorrowOrigin,
  ctx: BodyContext,
): ReturnedBorrowOrigin["endpointAccess"] => {
  const parameterType = info.signature?.parameters[parameterIndex]?.type;
  const entry =
    typeof parameterType === "number"
      ? borrowedTypeEntriesInType(parameterType, ctx.typing).find(
          ({ path }) => JSON.stringify(path) === JSON.stringify(origin.source),
        )
      : undefined;
  if (entry && ctx.typing.arena.get(entry.inner).kind === "type-param-ref") {
    const actual = info.arguments[parameterIndex];
    const actualType =
      typeof actual === "number" ? typeOfExpr(actual, ctx) : undefined;
    const actualSourceTypes =
      typeof actualType === "number"
        ? projectedTypes(actualType, origin.source, ctx.typing)
        : [];
    if (actualSourceTypes.length > 0) {
      return actualSourceTypes.some((type) =>
        borrowedEndpointIsDereferenced(type, ctx.typing),
      )
        ? "dereferenced"
        : "inline";
    }
  }
  return entry
    ? borrowedEndpointIsDereferenced(entry.inner, ctx.typing)
      ? "dereferenced"
      : "inline"
    : origin.endpointAccess;
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
      const origins = returnedOrigins(parameter);
      return origins.flatMap((origin) => {
        const translated = translateProjectionPath({
          result: origin.result,
          source: origin.source,
          requested,
        });
        if (!translated) {
          return [];
        }
        return placesAtProjection(actual, translated, ctx, new Set(seen)).map(
          (place) =>
            applyBorrowEndpoint(
              place,
              specializedReturnedEndpoint(info, index, origin, ctx),
            ),
        );
      });
    }) ?? [],
  );

const returnedOrigins = (
  parameter: CallableBorrowContract["parameters"][number],
): readonly ReturnedBorrowOrigin[] =>
  parameter.returnedOrigins && parameter.returnedOrigins.length > 0
    ? parameter.returnedOrigins
    : (parameter.returnedPaths && parameter.returnedPaths.length > 0
        ? parameter.returnedPaths
        : [[]]
      ).map((source) => ({ source, result: [] }));

const returnedOriginIsShared = (
  parameter: CallableBorrowContract["parameters"][number],
  origin: ReturnedBorrowOrigin,
): boolean =>
  parameter.returnedSharedOrigins?.some(
    (shared) => JSON.stringify(shared) === JSON.stringify(origin),
  ) === true;

const expressionCarriesBorrowedProvenance = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): boolean =>
  expressionProjectionCarriesBorrowedProvenance(exprId, [], ctx, seen);

const expressionMaterializesPlainProjection = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const expression = ctx.hir.expressions.get(exprId);
  const type = typeOfExpr(exprId, ctx);
  return (
    expression?.exprKind === "field-access" &&
    typeof type === "number" &&
    !typeContainsBorrowed(type, ctx.typing)
  );
};

const objectLiteralProjectionProvider = ({
  expression,
  projection,
  ctx,
}: {
  expression: Extract<HirExpression, { exprKind: "object-literal" }>;
  projection: Extract<PlaceProjection, { kind: "field" }>;
  ctx: BodyContext;
}): (typeof expression.entries)[number] | undefined =>
  objectLiteralFieldProvider({
    expression,
    field: projection.name,
    spreadProvidesField: (value) => {
      const spreadType = typeOfExpr(value, ctx);
      return (
        typeof spreadType === "number" &&
        projectedTypes(spreadType, [projection], ctx.typing).length > 0
      );
    },
  });

const expressionProjectionCarriesBorrowedProvenance = (
  exprId: HirExprId,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
  seen: Set<HirExprId>,
): boolean => {
  if (seen.has(exprId)) {
    return false;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (isSharedCellValueExpression(exprId, ctx)) {
    return true;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    const type = typeOfExpr(expr.id, ctx);
    if (typeof type !== "number") {
      return false;
    }
    const borrowedPaths = borrowedPathsInType(type, ctx.typing);
    if (borrowedPaths.length === 0) {
      return false;
    }
    const requestedCarriesBorrow = borrowedPaths.some(
      (path) =>
        requested.length === 0 ||
        projectionPathCovers(path, requested) ||
        projectionPathCovers(requested, path),
    );
    return (
      requestedCarriesBorrow &&
      (targetInfo(expr, ctx).contract?.parameters.some(
        (parameter) =>
          parameter.returnedSharedOrigins &&
          parameter.returnedSharedOrigins.length > 0,
      ) ??
        false)
    );
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const aliases = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    if (aliases.length > 0) {
      return aliases.some(
        (alias) =>
          alias.provenance === "storage-borrow" &&
          (requested.length === 0 ||
            alias.resultProjections === undefined ||
            translateProjectionPath({
              result: alias.resultProjections,
              source: [],
              requested,
            }) !== undefined),
      );
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? expressionProjectionCarriesBorrowedProvenance(
          initializer,
          requested,
          ctx,
          seen,
        )
      : false;
  }
  if (expr.exprKind === "field-access") {
    if (
      requested.length === 0 &&
      expressionMaterializesPlainProjection(expr.id, ctx)
    ) {
      return false;
    }
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return expressionProjectionCarriesBorrowedProvenance(
      expr.target,
      [projection, ...requested],
      ctx,
      seen,
    );
  }
  if (expr.exprKind === "tuple") {
    if (requested.length > 0) {
      const [projection, ...remaining] = requested;
      const element =
        projection?.kind === "tuple"
          ? expr.elements[projection.index]
          : undefined;
      if (
        typeof element === "number" &&
        projection &&
        aggregateProjectionMaterializesBorrowedPrimitive(
          expr.id,
          element,
          projection,
          ctx,
        )
      ) {
        return false;
      }
      return typeof element === "number"
        ? expressionProjectionCarriesBorrowedProvenance(
            element,
            remaining,
            ctx,
            seen,
          )
        : false;
    }
    return expr.elements.some(
      (element, index) =>
        !aggregateProjectionMaterializesBorrowedPrimitive(
          expr.id,
          element,
          { kind: "tuple", index },
          ctx,
        ) &&
        expressionProjectionCarriesBorrowedProvenance(
          element,
          [],
          ctx,
          new Set(seen),
        ),
    );
  }
  if (expr.exprKind === "object-literal") {
    if (requested.length > 0) {
      const [projection, ...remaining] = requested;
      const provider =
        projection?.kind === "field"
          ? objectLiteralProjectionProvider({
              expression: expr,
              projection,
              ctx,
            })
          : undefined;
      if (
        provider?.kind === "field" &&
        projection &&
        aggregateProjectionMaterializesBorrowedPrimitive(
          expr.id,
          provider.value,
          projection,
          ctx,
        )
      ) {
        return false;
      }
      return provider
        ? expressionProjectionCarriesBorrowedProvenance(
            provider.value,
            provider.kind === "spread" ? requested : remaining,
            ctx,
            seen,
          )
        : false;
    }
    return expr.entries.some(
      (entry) =>
        (entry.kind !== "field" ||
          !aggregateProjectionMaterializesBorrowedPrimitive(
            expr.id,
            entry.value,
            { kind: "field", name: entry.name },
            ctx,
          )) &&
        expressionProjectionCarriesBorrowedProvenance(
          entry.value,
          [],
          ctx,
          new Set(seen),
        ),
    );
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return expressionProjectionCarriesBorrowedProvenance(
      expr.value,
      requested,
      ctx,
      seen,
    );
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      expr.branches.some((branch) =>
        expressionProjectionCarriesBorrowedProvenance(
          branch.value,
          requested,
          ctx,
          new Set(seen),
        ),
      ) ||
      (typeof expr.defaultBranch === "number" &&
        expressionProjectionCarriesBorrowedProvenance(
          expr.defaultBranch,
          requested,
          ctx,
          new Set(seen),
        ))
    );
  }
  if (expr.exprKind === "match") {
    return expr.arms.some((arm) =>
      expressionProjectionCarriesBorrowedProvenance(
        arm.value,
        requested,
        ctx,
        new Set(seen),
      ),
    );
  }
  if (expr.exprKind === "effect-handler") {
    return (
      expressionProjectionCarriesBorrowedProvenance(
        expr.body,
        requested,
        ctx,
        new Set(seen),
      ) ||
      expr.handlers.some((handler) =>
        expressionProjectionCarriesBorrowedProvenance(
          handler.body,
          requested,
          ctx,
          new Set(seen),
        ),
      )
    );
  }
  return false;
};

const expressionReturnsDetachedSharedValue = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    const resultType = typeOfExpr(expr.id, ctx);
    if (
      typeof resultType === "number" &&
      typeContainsBorrowed(resultType, ctx.typing)
    ) {
      return false;
    }
    const returnedParameters =
      targetInfo(expr, ctx).contract?.parameters.filter(
        (parameter) => parameter.returned,
      ) ?? [];
    return (
      returnedParameters.length > 0 &&
      returnedParameters.every((parameter) => {
        const resultOrigins = returnedOrigins(parameter);
        return (
          resultOrigins.length > 0 &&
          resultOrigins.every(
            (origin) =>
              parameter.returnedSharedOrigins?.some(
                (shared) => JSON.stringify(shared) === JSON.stringify(origin),
              ) === true,
          )
        );
      })
    );
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return expressionReturnsDetachedSharedValue(expr.value, ctx);
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    const values = [
      ...expr.branches.map((branch) => branch.value),
      ...(typeof expr.defaultBranch === "number" ? [expr.defaultBranch] : []),
    ];
    return (
      values.length > 0 &&
      values.every((value) => expressionReturnsDetachedSharedValue(value, ctx))
    );
  }
  if (expr.exprKind === "match") {
    return (
      expr.arms.length > 0 &&
      expr.arms.every((arm) =>
        expressionReturnsDetachedSharedValue(arm.value, ctx),
      )
    );
  }
  return false;
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
      const translated = translateProjectionPath({
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
  if (expr.exprKind === "effect-handler") {
    return uniquePlaces([
      ...projectedReturnedPlaces(expr.body, requested, ctx, new Set(seen)),
      ...expr.handlers.flatMap((handler) =>
        projectedReturnedPlaces(handler.body, requested, ctx, new Set(seen)),
      ),
    ]);
  }
  if (expr.exprKind === "object-literal") {
    if (requested.length === 0) {
      return aggregateContentsPlaces(expr.id, ctx);
    }
    const [projection, ...remaining] = requested;
    if (projection?.kind !== "field") {
      return [];
    }
    const provider = objectLiteralProjectionProvider({
      expression: expr,
      projection,
      ctx,
    });
    if (!provider) {
      return [];
    }
    const providerPath = provider.kind === "spread" ? requested : remaining;
    return providerPath.length === 0
      ? placesOfExpression(provider.value, ctx, new Set(seen))
      : placesAtProjection(provider.value, providerPath, ctx, new Set(seen));
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
    appendExpressionAccess(place, exprId, requested, ctx),
  );
}

function recordExpressionUse(
  exprId: HirExprId,
  event: Event,
  paths: readonly (readonly PlaceProjection[])[] | undefined,
  ctx: BodyContext,
): void {
  if (paths?.length === 0) {
    return;
  }
  const symbol = baseSymbolOf(exprId, ctx);
  if (typeof symbol !== "number") {
    return;
  }
  const uses = ctx.uses.get(symbol) ?? [];
  if (!uses.includes(event)) {
    uses.push(event);
    ctx.uses.set(symbol, uses);
  }
  const places = uniquePlaces(
    paths?.length
      ? paths.flatMap((path) =>
          placesAtProjection(exprId, path, ctx, new Set()),
        )
      : placesOfExpression(exprId, ctx),
  );
  if (places.length === 0) {
    return;
  }
  const byEvent = ctx.usePlaces.get(symbol) ?? new Map();
  byEvent.set(event, uniquePlaces([...(byEvent.get(event) ?? []), ...places]));
  ctx.usePlaces.set(symbol, byEvent);
}

const appendEndpointToPath = (
  path: readonly PlaceProjection[],
  dereferenced: boolean,
): readonly PlaceProjection[] =>
  dereferenced ? [...path, { kind: "dereference" }] : path;

const uniqueProjectionPaths = (
  paths: readonly (readonly PlaceProjection[])[],
): readonly (readonly PlaceProjection[])[] =>
  Array.from(
    new Map(paths.map((path) => [JSON.stringify(path), path])).values(),
  );

const explicitBorrowAccessPaths = (
  info: ResolvedBorrowCall,
  index: number,
  ctx: BodyContext,
): readonly (readonly PlaceProjection[])[] => {
  const actual = info.arguments[index];
  const actualType =
    typeof actual === "number" ? typeOfExpr(actual, ctx) : undefined;
  const actualEntries =
    typeof actualType === "number"
      ? borrowedTypeEntriesInType(actualType, ctx.typing)
      : [];
  const parameterType = info.signature?.parameters[index]?.type;
  const typePaths =
    typeof parameterType === "number"
      ? borrowedTypeEntriesInType(parameterType, ctx.typing).map((entry) =>
          hasMatchingBorrowedTypeEntry(entry, actualEntries)
            ? entry.path
            : appendEndpointToPath(
                entry.path,
                borrowedEndpointIsDereferenced(entry.inner, ctx.typing),
              ),
        )
      : [];
  const returnedPaths =
    typeof info.signature?.returnType === "number" &&
    typeContainsBorrowed(info.signature.returnType, ctx.typing)
      ? (info.contract?.parameters[index]?.returnedSharedOrigins?.map(
          (origin) =>
            actualEntries.some(
              (entry) =>
                JSON.stringify(entry.path) === JSON.stringify(origin.source),
            )
              ? origin.source
              : appendEndpointToPath(
                  origin.source,
                  specializedReturnedEndpoint(info, index, origin, ctx) ===
                    "dereferenced",
                ),
        ) ?? [])
      : [];
  return uniqueProjectionPaths([...typePaths, ...returnedPaths]);
};

const recordCallUses = (
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  event: Event,
  ctx: BodyContext,
): void => {
  if (expr.exprKind === "call") {
    recordExpressionUse(expr.callee, event, undefined, ctx);
  }
  const resolved = targetInfo(expr, ctx);
  resolved.arguments.forEach((actual, index) => {
    if (typeof actual !== "number") {
      return;
    }
    recordExpressionUse(
      actual,
      event,
      (() => {
        const parameter = resolved.contract?.parameters[index];
        const paths = [
          ...(parameter?.readPaths ?? []),
          ...(parameter?.writePaths ?? []),
          ...explicitBorrowAccessPaths(resolved, index, ctx),
        ];
        return paths.length > 0
          ? uniqueProjectionPaths(paths)
          : parameter
            ? []
            : undefined;
      })(),
      ctx,
    );
  });
};

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
  provenance: AliasDefinition["provenance"];
  access?: AliasDefinition["access"];
  capture?: boolean;
};

const uniqueAggregateOrigins = (
  origins: readonly AggregateOrigin[],
): readonly AggregateOrigin[] =>
  Array.from(
    new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values(),
  );

const aggregateOriginAccess = (
  exprId: HirExprId,
  place: BorrowPlace,
  ctx: BodyContext,
  requested: readonly PlaceProjection[] = [],
): AliasDefinition["access"] =>
  expressionOriginMetadata(exprId, place, ctx, new Set(), requested).access;

const expressionOriginIsCapture = (
  exprId: HirExprId,
  place: BorrowPlace,
  ctx: BodyContext,
  requested: readonly PlaceProjection[] = [],
): boolean =>
  expressionOriginMetadata(exprId, place, ctx, new Set(), requested).capture;

const explicitBorrowedEntryAtPath = (
  exprId: HirExprId,
  path: readonly PlaceProjection[],
  ctx: BodyContext,
): BorrowedTypeEntry | undefined => {
  const type = typeOfExpr(exprId, ctx);
  return typeof type === "number"
    ? borrowedTypeEntriesInType(type, ctx.typing).find(
        (entry) => JSON.stringify(entry.path) === JSON.stringify(path),
      )
    : undefined;
};

function expressionOriginMetadata(
  exprId: HirExprId,
  place: BorrowPlace,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
  requested: readonly PlaceProjection[] = [],
): { access: AliasDefinition["access"]; capture: boolean } {
  if (seen.has(exprId)) {
    return { access: "shared", capture: false };
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    const matching = reaching.filter(
      (alias) =>
        alias.place.root === place.root &&
        placeOverlaps(alias.place, place) &&
        (requested.length === 0 ||
          alias.resultProjections === undefined ||
          translateProjectionPath({
            result: alias.resultProjections,
            source: [],
            requested,
          }) !== undefined),
    );
    return {
      access: matching.some((alias) => alias.access === "mutable")
        ? "mutable"
        : "shared",
      capture: matching.some((alias) => alias.capture === true),
    };
  }
  if (expr?.exprKind === "lambda") {
    const event = ctx.events.get(expr.id);
    if (!event) {
      return { access: "shared", capture: false };
    }
    const captures = lambdaCaptureOrigins(expr, event, ctx).filter(
      ({ capture, place: capturedPlace }) =>
        capturedPlace.root === place.root &&
        placeOverlaps(capturedPlace, place) &&
        lambdaMutablyUsesCapture(expr, capture.symbol, ctx),
    );
    return {
      access: captures.length > 0 ? "mutable" : "shared",
      capture: captures.length > 0,
    };
  }
  if (expr?.exprKind === "field-access") {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return expressionOriginMetadata(expr.target, place, ctx, new Set(seen), [
      projection,
      ...requested,
    ]);
  }
  if (expr?.exprKind === "tuple") {
    if (requested.length > 0) {
      const [projection, ...remaining] = requested;
      const element =
        projection?.kind === "tuple"
          ? expr.elements[projection.index]
          : undefined;
      return typeof element === "number"
        ? expressionOriginMetadata(
            element,
            place,
            ctx,
            new Set(seen),
            remaining,
          )
        : { access: "shared", capture: false };
    }
    const metadata = expr.elements.map((element) =>
      expressionOriginMetadata(element, place, ctx, new Set(seen)),
    );
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  if (expr?.exprKind === "object-literal") {
    if (requested.length > 0) {
      const [projection, ...remaining] = requested;
      const entry =
        projection?.kind === "field"
          ? expr.entries.find(
              (candidate) =>
                candidate.kind === "field" &&
                candidate.name === projection.name,
            )
          : undefined;
      return entry
        ? expressionOriginMetadata(
            entry.value,
            place,
            ctx,
            new Set(seen),
            remaining,
          )
        : { access: "shared", capture: false };
    }
    const metadata = expr.entries.map((entry) =>
      expressionOriginMetadata(entry.value, place, ctx, new Set(seen)),
    );
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  if (expr?.exprKind === "match") {
    const metadata = expr.arms.map((arm) =>
      expressionOriginMetadata(arm.value, place, ctx, new Set(seen), requested),
    );
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  if (expr?.exprKind === "effect-handler") {
    const metadata = [
      expressionOriginMetadata(expr.body, place, ctx, new Set(seen), requested),
      ...expr.handlers.map((handler) =>
        expressionOriginMetadata(
          handler.body,
          place,
          ctx,
          new Set(seen),
          requested,
        ),
      ),
    ];
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  if (expr?.exprKind === "call" || expr?.exprKind === "method-call") {
    const info = targetInfo(expr, ctx);
    const metadata =
      info.contract?.parameters.flatMap((parameter, index) => {
        const actual = info.arguments[index];
        if (!parameter.returned || typeof actual !== "number") {
          return [];
        }
        return returnedOrigins(parameter).flatMap((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          if (!translated) {
            return [];
          }
          return placesAtProjection(actual, translated, ctx, new Set(seen))
            .map((actualPlace) =>
              applyBorrowEndpoint(
                actualPlace,
                specializedReturnedEndpoint(info, index, origin, ctx),
              ),
            )
            .some(
              (actualPlace) =>
                actualPlace.root === place.root &&
                placeOverlaps(actualPlace, place),
            )
            ? [
                expressionOriginMetadata(
                  actual,
                  place,
                  ctx,
                  new Set(seen),
                  translated,
                ),
              ]
            : [];
        });
      }) ?? [];
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  if (expr?.exprKind === "block" && typeof expr.value === "number") {
    return expressionOriginMetadata(expr.value, place, ctx, seen, requested);
  }
  if (expr?.exprKind === "if" || expr?.exprKind === "cond") {
    const metadata = [
      ...expr.branches.map((branch) =>
        expressionOriginMetadata(
          branch.value,
          place,
          ctx,
          new Set(seen),
          requested,
        ),
      ),
      ...(typeof expr.defaultBranch === "number"
        ? [
            expressionOriginMetadata(
              expr.defaultBranch,
              place,
              ctx,
              new Set(seen),
              requested,
            ),
          ]
        : []),
    ];
    return {
      access: metadata.some((origin) => origin.access === "mutable")
        ? "mutable"
        : "shared",
      capture: metadata.some((origin) => origin.capture),
    };
  }
  return { access: "shared", capture: false };
}

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
  if (expr?.exprKind === "effect-handler") {
    return uniqueAggregateOrigins([
      ...aggregateOriginsOfExpression(expr.body, ctx, new Set(seen)),
      ...expr.handlers.flatMap((handler) =>
        aggregateOriginsOfExpression(handler.body, ctx, new Set(seen)),
      ),
    ]);
  }
  if (expr?.exprKind === "field-access") {
    const requested = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    const projected = uniqueAggregateOrigins(
      aggregateOriginsOfExpression(expr.target, ctx, new Set(seen)).flatMap(
        (origin) => {
          const projected = projectAggregateOrigin(origin, requested);
          return projected &&
            (projected.resultProjections.length > 0 ||
              projected.capture === true)
            ? [projected]
            : [];
        },
      ),
    );
    return expressionMaterializesPlainProjection(expr.id, ctx)
      ? projected.filter((origin) => origin.capture === true)
      : projected;
  }
  if (expr?.exprKind === "call" || expr?.exprKind === "method-call") {
    const info = targetInfo(expr, ctx);
    const returned = info.contract?.parameters.flatMap((parameter, index) => {
      const actual = info.arguments[index];
      if (typeof actual !== "number" || !parameter.returned) {
        return [];
      }
      return returnedOrigins(parameter).flatMap((origin) => {
        const places = placesAtProjection(
          actual,
          origin.source,
          ctx,
          new Set(seen),
        ).map((place) =>
          applyBorrowEndpoint(
            place,
            specializedReturnedEndpoint(info, index, origin, ctx),
          ),
        );
        return places.flatMap((place) => {
          const capture = expressionOriginIsCapture(
            actual,
            place,
            ctx,
            origin.source,
          );
          if (origin.result.length === 0 && !capture) {
            return [];
          }
          return [
            {
              place,
              resultProjections: origin.result,
              provenance: returnedOriginIsShared(parameter, origin)
                ? ("storage-borrow" as const)
                : ("allocation-alias" as const),
              access: aggregateOriginAccess(actual, place, ctx, origin.source),
              capture,
            },
          ];
        });
      });
    });
    const transferred = info.contract?.transfers?.flatMap((transfer) => {
      const actual = info.arguments[transfer.sourceParameter];
      const destination =
        info.contract?.parameters[transfer.destinationParameter];
      if (typeof actual !== "number" || !destination?.returned) {
        return [];
      }
      const destinationPath = transfer.destinationPath ?? [];
      const returnedOrigins =
        destination.returnedOrigins && destination.returnedOrigins.length > 0
          ? destination.returnedOrigins
          : (destination.returnedPaths && destination.returnedPaths.length > 0
              ? destination.returnedPaths
              : [[]]
            ).map((source) => ({ source, result: [] }));
      const resultPaths = returnedOrigins.flatMap((origin) => {
        const translated = translateProjectionPath({
          result: origin.source,
          source: origin.result,
          requested: destinationPath,
        });
        return translated ? [translated] : [];
      });
      return placesAtProjection(
        actual,
        transfer.sourcePath ?? [],
        ctx,
        new Set(seen),
      ).flatMap((place) =>
        resultPaths.map((resultProjections) => ({
          place,
          resultProjections,
          provenance:
            transfer.borrowsSource === true
              ? ("storage-borrow" as const)
              : ("allocation-alias" as const),
          access: aggregateOriginAccess(
            actual,
            place,
            ctx,
            transfer.sourcePath ?? [],
          ),
          capture: expressionOriginIsCapture(
            actual,
            place,
            ctx,
            transfer.sourcePath ?? [],
          ),
        })),
      );
    });
    return uniqueAggregateOrigins([
      ...(returned ?? []),
      ...(transferred ?? []),
    ]);
  }
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    const contained = reaching.map((alias) => ({
      place: alias.place,
      resultProjections: alias.resultProjections ?? [],
      provenance: alias.provenance,
      access: alias.access,
      capture: alias.capture,
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
        if (
          aggregateProjectionMaterializesBorrowedPrimitive(
            expr.id,
            value,
            projection,
            ctx,
          )
        ) {
          return [];
        }
        const explicitBorrow = explicitBorrowedEntryAtPath(
          expr.id,
          [projection],
          ctx,
        );
        const alreadyBorrowed = expressionCarriesBorrowedProvenance(value, ctx);
        const direct = isReferenceLike(typeOfExpr(value, ctx), ctx)
          ? placesOfExpression(value, ctx).map((place) => ({
              place:
                explicitBorrow &&
                !alreadyBorrowed &&
                borrowedEndpointIsDereferenced(explicitBorrow.inner, ctx.typing)
                  ? applyBorrowEndpoint(place, "dereferenced")
                  : place,
              resultProjections: [projection],
              provenance:
                explicitBorrow || alreadyBorrowed
                  ? ("storage-borrow" as const)
                  : ("allocation-alias" as const),
              access: aggregateOriginAccess(value, place, ctx),
              capture: expressionOriginIsCapture(value, place, ctx),
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
    const originsForField = (
      entry: Extract<(typeof expr.entries)[number], { kind: "field" }>,
    ): readonly AggregateOrigin[] => {
      const projection = {
        kind: "field" as const,
        name: entry.name,
      };
      if (
        aggregateProjectionMaterializesBorrowedPrimitive(
          expr.id,
          entry.value,
          projection,
          ctx,
        )
      ) {
        return [];
      }
      const explicitBorrow = explicitBorrowedEntryAtPath(
        expr.id,
        [projection],
        ctx,
      );
      const alreadyBorrowed = expressionCarriesBorrowedProvenance(
        entry.value,
        ctx,
      );
      const direct = isReferenceLike(typeOfExpr(entry.value, ctx), ctx)
        ? placesOfExpression(entry.value, ctx).map((place) => ({
            place:
              explicitBorrow &&
              !alreadyBorrowed &&
              borrowedEndpointIsDereferenced(explicitBorrow.inner, ctx.typing)
                ? applyBorrowEndpoint(place, "dereferenced")
                : place,
            resultProjections: [projection],
            provenance:
              explicitBorrow || alreadyBorrowed
                ? ("storage-borrow" as const)
                : ("allocation-alias" as const),
            access: aggregateOriginAccess(entry.value, place, ctx),
            capture: expressionOriginIsCapture(entry.value, place, ctx),
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
    };
    return uniqueAggregateOrigins(
      expr.entries.reduce<AggregateOrigin[]>((origins, entry) => {
        if (entry.kind === "field") {
          return [
            ...origins.filter((origin) => {
              const provided = origin.resultProjections[0];
              return provided?.kind !== "field" || provided.name !== entry.name;
            }),
            ...originsForField(entry),
          ];
        }
        const spreadType = typeOfExpr(entry.value, ctx);
        const retained = origins.filter((origin) => {
          const provided = origin.resultProjections[0];
          return (
            provided?.kind !== "field" ||
            typeof spreadType !== "number" ||
            projectedTypes(spreadType, [provided], ctx.typing).length === 0
          );
        });
        const spreadOrigins = aggregateOriginsOfExpression(
          entry.value,
          ctx,
          new Set(seen),
        );
        const spreadDescriptor =
          typeof spreadType === "number"
            ? ctx.typing.arena.get(spreadType)
            : undefined;
        const resultType = typeOfExpr(expr.id, ctx);
        const materializedOrigins =
          spreadDescriptor?.kind === "borrowed" &&
          typeof spreadType === "number" &&
          typeof resultType === "number"
            ? spreadOrigins.flatMap((origin) => {
                if (
                  origin.resultProjections.length > 0 ||
                  origin.provenance !== "storage-borrow"
                ) {
                  return [origin];
                }
                return materializedObjectReferencePaths(
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
                  if (
                    !fieldTypes.some((type) =>
                      typeCanCarryReference(type, ctx.typing),
                    )
                  ) {
                    return [];
                  }
                  return [
                    {
                      ...origin,
                      place: appendExpressionAccess(
                        origin.place,
                        entry.value,
                        path,
                        ctx,
                      ),
                      resultProjections: path,
                      provenance: fieldTypes.some((type) =>
                        typeContainsBorrowed(type, ctx.typing),
                      )
                        ? ("storage-borrow" as const)
                        : ("allocation-alias" as const),
                    },
                  ];
                });
              })
            : spreadOrigins;
        return [...retained, ...materializedOrigins];
      }, []),
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
    (isSharedCellValueExpression(exprId, ctx) &&
      !expressionCarriesBorrowedProvenance(exprId, ctx)) ||
    aggregateContentsPlaces(exprId, ctx).length > 0
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
  if (expr?.exprKind === "call" || expr?.exprKind === "method-call") {
    return (
      targetInfo(expr, ctx).contract?.parameters.some((parameter) =>
        parameter.returnedOrigins?.some((origin) => origin.result.length > 0),
      ) === true
    );
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
  return false;
};

const projectAggregateOrigin = (
  origin: AggregateOrigin,
  projection: PlaceProjection,
): AggregateOrigin | undefined => {
  const translated = translateProjectionPath({
    result: origin.resultProjections,
    source: origin.place.projections,
    requested: [projection],
  });
  if (!translated) {
    return undefined;
  }
  return {
    place: { root: origin.place.root, projections: translated },
    provenance: origin.provenance,
    access: origin.access,
    capture: origin.capture,
    resultProjections:
      origin.resultProjections.length > 1
        ? origin.resultProjections.slice(1)
        : [],
  };
};

const bindPatternAggregateOrigin = ({
  pattern,
  origin,
  mutable,
  provenance = "allocation-alias",
  span,
  event,
  ctx,
}: {
  pattern: HirPattern;
  origin: AggregateOrigin;
  mutable: boolean;
  provenance?: AliasDefinition["provenance"];
  span: SourceSpan;
  event: Event;
  ctx: BodyContext;
}): void => {
  switch (pattern.kind) {
    case "identifier": {
      const bindingType = ctx.typing.valueTypes.get(pattern.symbol);
      const bindingContainsBorrow =
        typeof bindingType === "number" &&
        typeContainsBorrowed(bindingType, ctx.typing);
      const alias: AliasDefinition = {
        symbol: pattern.symbol,
        place: origin.place,
        access:
          pattern.bindingKind === "mutable-ref" || mutable
            ? "mutable"
            : (origin.access ?? "shared"),
        provenance:
          pattern.bindingKind === "mutable-ref" || mutable
            ? "storage-borrow"
            : bindingContainsBorrow
              ? origin.provenance
              : "allocation-alias",
        span: pattern.span ?? span,
        event,
        uses: [],
        ...(origin.capture === true ? { capture: true } : {}),
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
            provenance,
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
            provenance,
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
          provenance,
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
          provenance,
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
  provenance = "allocation-alias",
  span,
  event,
  ctx,
}: {
  pattern: HirPattern;
  value: HirExprId;
  mutable: boolean;
  provenance?: AliasDefinition["provenance"];
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
          provenance: expressionCarriesBorrowedProvenance(element, ctx)
            ? "storage-borrow"
            : "allocation-alias",
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
          provenance,
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
          provenance,
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
          provenance: expressionCarriesBorrowedProvenance(entry.value, ctx)
            ? "storage-borrow"
            : "allocation-alias",
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
          provenance,
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
          provenance,
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
      provenance,
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
        provenance,
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
          : (origin.access ?? "shared"),
      provenance:
        directPlaces.length > 0 &&
        (mutable || pattern.bindingKind === "mutable-ref")
          ? "storage-borrow"
          : origin.provenance,
      span: pattern.span ?? span,
      event,
      uses: [],
      ...(origin.capture === true ? { capture: true } : {}),
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

const bindPatternInitializers = ({
  pattern,
  value,
  ctx,
}: {
  pattern: HirPattern;
  value: HirExprId;
  ctx: BodyContext;
}): void => {
  const expression = ctx.hir.expressions.get(value);
  if (pattern.kind === "identifier") {
    ctx.bindingInitializers.set(pattern.symbol, value);
    return;
  }
  if (pattern.kind === "tuple" && expression?.exprKind === "tuple") {
    pattern.elements.forEach((element, index) => {
      const initializer = expression.elements[index];
      if (typeof initializer === "number") {
        bindPatternInitializers({
          pattern: element,
          value: initializer,
          ctx,
        });
      }
    });
    return;
  }
  if (
    pattern.kind === "destructure" &&
    expression?.exprKind === "object-literal"
  ) {
    pattern.fields.forEach((field) => {
      const initializer = expression.entries.find(
        (entry) => entry.kind === "field" && entry.name === field.name,
      )?.value;
      if (typeof initializer === "number") {
        bindPatternInitializers({
          pattern: field.pattern,
          value: initializer,
          ctx,
        });
      }
    });
    if (pattern.spread) {
      bindPatternInitializers({ pattern: pattern.spread, value, ctx });
    }
    return;
  }
  if (pattern.kind === "type" && pattern.binding) {
    bindPatternInitializers({ pattern: pattern.binding, value, ctx });
    return;
  }
  patternSymbols(pattern).forEach((symbol) =>
    ctx.bindingInitializers.set(symbol, value),
  );
};

const bindPatternPlaces = ({
  pattern,
  source,
  mutable,
  provenance = "allocation-alias",
  span,
  event,
  ctx,
  projection,
  conservativeReturnedAggregate = false,
}: {
  pattern: HirPattern;
  source?: BorrowPlace;
  mutable: boolean;
  provenance?: AliasDefinition["provenance"];
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
          provenance: bindingMutable ? "storage-borrow" : provenance,
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
          provenance,
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
          provenance,
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
          provenance,
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
          provenance,
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

const patternBindingsWithProjection = (
  pattern: HirPattern,
  prefix: readonly PlaceProjection[] = [],
): readonly {
  symbol: SymbolId;
  path: readonly PlaceProjection[];
  explicitType?: TypeId;
}[] => {
  switch (pattern.kind) {
    case "identifier":
      return [
        {
          symbol: pattern.symbol,
          path: prefix,
          ...(typeof pattern.typeId === "number"
            ? { explicitType: pattern.typeId }
            : typeof pattern.typeAnnotation?.typeId === "number"
              ? { explicitType: pattern.typeAnnotation.typeId }
              : {}),
        },
      ];
    case "tuple":
      return pattern.elements.flatMap((element, index) =>
        patternBindingsWithProjection(element, [
          ...prefix,
          { kind: "tuple", index },
        ]),
      );
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) =>
          patternBindingsWithProjection(field.pattern, [
            ...prefix,
            { kind: "field", name: field.name },
          ]),
        ),
        ...(pattern.spread
          ? patternBindingsWithProjection(pattern.spread, prefix)
          : []),
      ];
    case "type":
      return pattern.binding
        ? patternBindingsWithProjection(pattern.binding, prefix).map(
            (binding) => ({
              ...binding,
              ...(typeof pattern.typeId === "number"
                ? { explicitType: pattern.typeId }
                : typeof pattern.type.typeId === "number"
                  ? { explicitType: pattern.type.typeId }
                  : {}),
            }),
          )
        : [];
    case "wildcard":
      return [];
  }
};

const recordContextualBorrowAlias = (
  alias: AliasDefinition,
  ctx: BodyContext,
  assignment: boolean,
): void => {
  const resultKey = JSON.stringify(alias.resultProjections ?? []);
  const aliasAlreadyRecorded = (candidate: AliasDefinition): boolean =>
    candidate.symbol === alias.symbol &&
    candidate.event === alias.event &&
    JSON.stringify(candidate.resultProjections ?? []) === resultKey &&
    JSON.stringify(candidate.place) === JSON.stringify(alias.place) &&
    candidate.access === alias.access &&
    candidate.provenance === alias.provenance;
  if (assignment) {
    if (ctx.assignmentAliases.some(aliasAlreadyRecorded)) {
      return;
    }
    ctx.assignmentAliases.push(alias);
    return;
  }
  const current = ctx.aliases.get(alias.symbol);
  if (!current) {
    ctx.aliases.set(alias.symbol, alias);
    return;
  }
  if (
    aliasAlreadyRecorded(current) ||
    ctx.assignmentAliases.some(aliasAlreadyRecorded)
  ) {
    return;
  }
  ctx.assignmentAliases.push(alias);
};

const borrowFormationLeaves = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly HirExprId[] => {
  const expression = ctx.hir.expressions.get(exprId);
  if (
    expression?.exprKind === "block" &&
    typeof expression.value === "number"
  ) {
    return borrowFormationLeaves(expression.value, ctx);
  }
  if (expression?.exprKind === "if" || expression?.exprKind === "cond") {
    return [
      ...expression.branches.flatMap((branch) =>
        borrowFormationLeaves(branch.value, ctx),
      ),
      ...(typeof expression.defaultBranch === "number"
        ? borrowFormationLeaves(expression.defaultBranch, ctx)
        : []),
    ];
  }
  if (expression?.exprKind === "match") {
    return expression.arms.flatMap((arm) =>
      borrowFormationLeaves(arm.value, ctx),
    );
  }
  if (expression?.exprKind === "effect-handler") {
    return [
      ...borrowFormationLeaves(expression.body, ctx),
      ...expression.handlers.flatMap((handler) =>
        borrowFormationLeaves(handler.body, ctx),
      ),
    ];
  }
  return [exprId];
};

const placesForBorrowFormation = (
  exprId: HirExprId,
  path: readonly PlaceProjection[],
  ctx: BodyContext,
): readonly BorrowPlace[] =>
  path.length === 0
    ? directPlacesOfExpression(exprId, ctx)
    : placesAtProjection(exprId, path, ctx, new Set());

const nestedBorrowMayBeAbsentFromCall = (
  exprId: HirExprId,
  path: readonly PlaceProjection[],
  ctx: BodyContext,
): boolean => {
  const expression = ctx.hir.expressions.get(exprId);
  return (
    path.length > 0 &&
    (expression?.exprKind === "call" || expression?.exprKind === "method-call")
  );
};

const hasMatchingBorrowedTypeEntry = (
  candidate: BorrowedTypeEntry,
  entries: readonly BorrowedTypeEntry[],
): boolean => {
  const pathKey = JSON.stringify(candidate.path);
  return entries.some(
    (entry) =>
      entry.inner === candidate.inner && JSON.stringify(entry.path) === pathKey,
  );
};

const placesForBorrowedEntry = (
  exprId: HirExprId,
  entry: BorrowedTypeEntry,
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  const actualType = typeOfExpr(exprId, ctx);
  const actualEntries =
    typeof actualType === "number"
      ? borrowedTypeEntriesInType(actualType, ctx.typing)
      : [];
  return hasMatchingBorrowedTypeEntry(entry, actualEntries)
    ? placesAtProjection(exprId, entry.path, ctx, new Set())
    : placesForBorrowFormation(exprId, entry.path, ctx);
};

const scopeIsWithin = (
  scope: ScopeId,
  ancestor: ScopeId,
  ctx: BodyContext,
): boolean => {
  let current: ScopeId | null = scope;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = ctx.symbolTable.getScope(current).parent;
  }
  return false;
};

const sourceOutlivesBinding = (
  source: SymbolId,
  binding: SymbolId,
  ctx: BodyContext,
): boolean =>
  scopeIsWithin(
    ctx.symbolTable.getSymbol(binding).scope,
    ctx.symbolTable.getSymbol(source).scope,
    ctx,
  );

const bindContextualBorrowOriginForBinding = ({
  symbol,
  path,
  explicitType,
  value,
  span,
  event,
  assignment = false,
  ctx,
}: {
  symbol: SymbolId;
  path: readonly PlaceProjection[];
  explicitType?: TypeId;
  value: HirExprId;
  span: SourceSpan;
  event: Event;
  assignment?: boolean;
  ctx: BodyContext;
}): void => {
  const type = explicitType ?? ctx.typing.valueTypes.get(symbol);
  if (typeof type !== "number") {
    return;
  }
  borrowedTypeEntriesInType(type, ctx.typing).forEach((entry) => {
    const sourcePath = [...path, ...entry.path];
    borrowFormationLeaves(value, ctx).forEach((leaf) => {
      if (!expressionProvidesProjection(leaf, sourcePath, ctx)) {
        return;
      }
      const sources = placesForBorrowedEntry(
        leaf,
        { path: sourcePath, inner: entry.inner },
        ctx,
      );
      if (sources.length === 0) {
        if (nestedBorrowMayBeAbsentFromCall(leaf, sourcePath, ctx)) {
          return;
        }
        addDiagnostic(
          diagnosticFromCode({
            code: "TY0051",
            params: {
              kind: "explicit-borrow-escape",
              binding: ctx.symbolTable.getSymbol(symbol).name,
              through: "borrow formation without stable origin storage",
            },
            span,
          }),
          ctx,
        );
        return;
      }
      sources.forEach((source) => {
        if (!sourceOutlivesBinding(source.root, symbol, ctx)) {
          addDiagnostic(
            diagnosticFromCode({
              code: "TY0051",
              params: {
                kind: "explicit-borrow-escape",
                binding: ctx.symbolTable.getSymbol(symbol).name,
                through: "a binding that outlives its lexical origin",
              },
              span,
            }),
            ctx,
          );
          return;
        }
        recordContextualBorrowAlias(
          {
            symbol,
            place: borrowedEndpointIsDereferenced(entry.inner, ctx.typing)
              ? applyBorrowEndpoint(source, "dereferenced")
              : source,
            access: "shared",
            provenance: "storage-borrow",
            span,
            event,
            uses: [],
            ...(entry.path.length > 0 ? { resultProjections: entry.path } : {}),
          },
          ctx,
          assignment,
        );
      });
    });
  });
};

const bindContextualBorrowOrigins = ({
  pattern,
  value,
  span,
  event,
  ctx,
}: {
  pattern: HirPattern;
  value: HirExprId;
  span: SourceSpan;
  event: Event;
  ctx: BodyContext;
}): void => {
  patternBindingsWithProjection(pattern).forEach(
    ({ symbol, path, explicitType }) =>
      bindContextualBorrowOriginForBinding({
        symbol,
        path,
        explicitType,
        value,
        span,
        event,
        ctx,
      }),
  );
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
      scanExpression(
        expr.target,
        { ...scan, suppressPlaceAccess: true, suppressUse: true },
        ctx,
      );
      break;
    case "tuple":
      expr.elements.forEach((element) => scanExpression(element, scan, ctx));
      break;
    case "object-literal":
      expr.entries.forEach((entry) => scanExpression(entry.value, scan, ctx));
      break;
    case "call":
      scanExpression(
        expr.callee,
        { ...scan, suppressPlaceAccess: true, suppressUse: true },
        ctx,
      );
      expr.args.forEach((arg) =>
        scanExpression(
          arg.expr,
          {
            ...scan,
            suppressPlaceAccess: true,
            suppressUse:
              ctx.hir.expressions.get(arg.expr)?.exprKind === "identifier" ||
              ctx.hir.expressions.get(arg.expr)?.exprKind === "field-access",
          },
          ctx,
        ),
      );
      break;
    case "method-call":
      scanExpression(
        expr.target,
        {
          ...scan,
          suppressPlaceAccess: true,
          suppressUse:
            ctx.hir.expressions.get(expr.target)?.exprKind === "identifier" ||
            ctx.hir.expressions.get(expr.target)?.exprKind === "field-access",
        },
        ctx,
      );
      expr.args.forEach((arg) =>
        scanExpression(
          arg.expr,
          {
            ...scan,
            suppressPlaceAccess: true,
            suppressUse:
              ctx.hir.expressions.get(arg.expr)?.exprKind === "identifier" ||
              ctx.hir.expressions.get(arg.expr)?.exprKind === "field-access",
          },
          ctx,
        ),
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
          const returnsDetachedSharedValue =
            expressionReturnsDetachedSharedValue(statement.initializer, ctx);
          const provenance = expressionCarriesBorrowedProvenance(
            statement.initializer,
            ctx,
          )
            ? "storage-borrow"
            : "allocation-alias";
          const createsMutableBinding =
            statement.mutable ||
            statement.pattern.bindingKind === "mutable-ref";
          const materializesBorrowedPrimitive =
            expressionMaterializesBorrowedPrimitive(
              statement.initializer,
              typeof statement.pattern.typeId === "number"
                ? [statement.pattern.typeId]
                : patternSymbols(statement.pattern).map((symbol) =>
                    ctx.typing.valueTypes.get(symbol),
                  ),
              ctx,
            );
          const initializerHasAddressableRoot =
            baseSymbolOf(statement.initializer, ctx) !== undefined;
          const sources =
            returnsDetachedSharedValue || materializesBorrowedPrimitive
              ? []
              : createsMutableBinding && initializerHasAddressableRoot
                ? placesOfExpression(statement.initializer, ctx)
                : placesStoredByExpression(statement.initializer, ctx);
          const initializerType = typeOfExpr(statement.initializer, ctx);
          const dereferenceProjectedSource =
            statement.pattern.bindingKind === "mutable-ref" &&
            typeof initializerType === "number" &&
            typeIsAllocationBacked(initializerType, ctx.typing);
          const bind = (source?: BorrowPlace): void =>
            bindPatternPlaces({
              pattern: statement.pattern,
              source:
                source &&
                dereferenceProjectedSource &&
                source.projections.length > 0
                  ? appendProjection(source, { kind: "dereference" })
                  : source,
              mutable: !returnsDetachedSharedValue && createsMutableBinding,
              provenance,
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
          if (returnsDetachedSharedValue && createsMutableBinding) {
            patternSymbols(statement.pattern).forEach((symbol) =>
              ctx.aliases.set(symbol, {
                symbol,
                place: { root: symbol, projections: [] },
                access: "shared",
                provenance: "storage-borrow",
                span: statement.span,
                event,
                uses: [],
              }),
            );
          }
          const initializer = ctx.hir.expressions.get(statement.initializer);
          if (
            !returnsDetachedSharedValue &&
            !materializesBorrowedPrimitive &&
            !(createsMutableBinding && initializerHasAddressableRoot) &&
            (isAggregateExpression(statement.initializer, ctx) ||
              aggregateContentsPlaces(statement.initializer, ctx).length > 0)
          ) {
            bindAggregatePatternOrigins({
              pattern: statement.pattern,
              value: statement.initializer,
              mutable: createsMutableBinding,
              provenance,
              span: statement.span,
              event,
              ctx,
            });
          }
          bindContextualBorrowOrigins({
            pattern: statement.pattern,
            value: statement.initializer,
            span: statement.span,
            event,
            ctx,
          });
          if (!materializesBorrowedPrimitive) {
            bindPatternInitializers({
              pattern: statement.pattern,
              value: statement.initializer,
              ctx,
            });
          }
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
              captureOrigins.forEach(({ capture, place, source }) => {
                const mutableCapture = lambdaMutablyUsesCapture(
                  initializer,
                  capture.symbol,
                  ctx,
                );
                ctx.assignmentAliases.push({
                  symbol,
                  place,
                  access: mutableCapture ? "mutable" : "shared",
                  provenance: mutableCapture
                    ? "storage-borrow"
                    : (source?.provenance ?? "allocation-alias"),
                  span: capture.span,
                  event,
                  uses: [],
                  capture: true,
                });
              });
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
          const materializesBorrowedPrimitive =
            expressionMaterializesBorrowedPrimitive(
              expr.value,
              [ctx.typing.valueTypes.get(target.symbol)],
              ctx,
            );
          const aggregateAssignment =
            !materializesBorrowedPrimitive &&
            (assigned?.exprKind === "tuple" ||
              assigned?.exprKind === "object-literal" ||
              isAggregateExpression(expr.value, ctx) ||
              aggregateContentsPlaces(expr.value, ctx).length > 0);
          if (aggregateAssignment) {
            ctx.bindingInitializers.set(target.symbol, expr.value);
          } else {
            ctx.bindingInitializers.delete(target.symbol);
          }
          ctx.unknownCallableBindings.add(target.symbol);
          const event = eventFor(expr.span, scan, ctx);
          ctx.reassignments.push({ symbol: target.symbol, event });
          const sources = materializesBorrowedPrimitive
            ? []
            : placesStoredByExpression(expr.value, ctx);
          const sourceActor = baseSymbolOf(expr.value, ctx);
          const preservesMutableCapability =
            hasMutableCapabilityAt(target.symbol, event, ctx) &&
            typeof sourceActor === "number" &&
            hasMutableCapabilityAt(sourceActor, event, ctx);
          const assignedProvenance = expressionCarriesBorrowedProvenance(
            expr.value,
            ctx,
          )
            ? "storage-borrow"
            : "allocation-alias";
          if (sources.length > 0) {
            sources.forEach((source) =>
              ctx.assignmentAliases.push({
                symbol: target.symbol,
                place: source,
                access: preservesMutableCapability ? "mutable" : "shared",
                provenance: preservesMutableCapability
                  ? "storage-borrow"
                  : assignedProvenance,
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
                provenance: origin.provenance,
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
          bindContextualBorrowOriginForBinding({
            symbol: target.symbol,
            path: [],
            value: expr.value,
            span: expr.span,
            event,
            assignment: true,
            ctx,
          });
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
  const event = recordExprEvent(expr, scan, ctx);
  if (expr.exprKind === "field-access" && scan.suppressUse !== true) {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    recordExpressionUse(
      expr.target,
      event,
      [accessProjectionsFor(expr.target, projection, ctx)],
      ctx,
    );
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    recordCallUses(expr, event, ctx);
  }
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
  return (
    left.root === right.root &&
    projectionPathsOverlap(left.projections, right.projections)
  );
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
    if (projection.kind === "discriminant") {
      return `${name}.<tag>`;
    }
    if (projection.kind === "identity") {
      return `${name}.<identity>`;
    }
    if (projection.kind === "dereference") {
      return `${name}.<allocation>`;
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
  allAliases(ctx).forEach((alias) => {
    if (alias.symbol === actor || !placeOverlaps(alias.place, place)) {
      return;
    }
    if (alias.provenance === "allocation-alias") {
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
    const explicitlyBorrowedParameter =
      explicitBorrowAccessPaths(info, index, ctx).length > 0;
    return access === "shared" &&
      !explicitlyBorrowedParameter &&
      !isReferenceLike(typeOfExpr(actual, ctx), ctx)
      ? "owned"
      : access;
  }
  const parameter = info.signature?.parameters[index];
  if (parameter?.bindingKind === "mutable-ref") {
    return "mutable";
  }
  return isReferenceLike(typeOfExpr(actual, ctx), ctx) ? "shared" : "owned";
};

const lambdaMutablyUsesCapture = (
  lambda: HirLambdaExpr,
  symbol: SymbolId,
  ctx: BodyContext,
): boolean => {
  type LocalEvent = {
    position: number;
    path: BranchPath;
  };
  type LocalDefinition = {
    symbol: SymbolId;
    value: HirExprId;
    projection: readonly PlaceProjection[];
    event: LocalEvent;
  };
  let mutable = false;
  const positions = new Map<HirExprId, number>();
  const exitPositions = new Map<HirExprId, number>();
  const paths = new Map<HirExprId, Map<number, number>>();
  const branchExpressions: HirExpression[] = [];
  const optionalRoots: HirExprId[][] = [];
  const exclusiveRoots: HirExprId[][] = [];
  let nextPosition = 0;
  walkExpression({
    exprId: lambda.body,
    hir: ctx.hir,
    onEnterExpression: (exprId, expr) => {
      positions.set(exprId, nextPosition++);
      if (
        expr.exprKind === "if" ||
        expr.exprKind === "cond" ||
        expr.exprKind === "match"
      ) {
        branchExpressions.push(expr);
      }
      if (expr.exprKind === "loop") {
        optionalRoots.push([expr.body]);
      }
      if (expr.exprKind === "while") {
        optionalRoots.push([expr.body]);
      }
      if (expr.exprKind === "effect-handler") {
        exclusiveRoots.push([
          expr.body,
          ...expr.handlers.map((handler) => handler.body),
        ]);
      }
      if (expr.exprKind === "lambda") {
        optionalRoots.push([expr.body]);
      }
      if (expr.exprKind === "if" || expr.exprKind === "cond") {
        expr.branches
          .slice(1)
          .forEach((branch) =>
            optionalRoots.push([branch.condition, branch.value]),
          );
      }
      if (expr.exprKind === "match") {
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            optionalRoots.push([arm.guard, arm.value]);
          }
        });
      }
    },
    onExitExpression: (exprId) => {
      exitPositions.set(exprId, nextPosition++);
    },
  });
  const tagBranch = (
    exprId: HirExprId,
    branchId: number,
    branchIndex: number,
  ): void =>
    walkExpression({
      exprId,
      hir: ctx.hir,
      onEnterExpression: (nestedId) => {
        const path = paths.get(nestedId) ?? new Map();
        path.set(branchId, branchIndex);
        paths.set(nestedId, path);
      },
    });
  branchExpressions.forEach((expr, branchId) => {
    if (expr.exprKind === "match") {
      expr.arms.forEach((arm, index) => tagBranch(arm.value, branchId, index));
      return;
    }
    if (expr.exprKind !== "if" && expr.exprKind !== "cond") {
      return;
    }
    expr.branches.forEach((branch, index) =>
      tagBranch(branch.value, branchId, index),
    );
    if (typeof expr.defaultBranch === "number") {
      tagBranch(expr.defaultBranch, branchId, expr.branches.length);
    }
  });
  optionalRoots.forEach((roots, optionalIndex) => {
    const branchId = branchExpressions.length + optionalIndex;
    roots.forEach((root) => tagBranch(root, branchId, 0));
  });
  exclusiveRoots.forEach((roots, exclusiveIndex) => {
    const branchId =
      branchExpressions.length + optionalRoots.length + exclusiveIndex;
    roots.forEach((root, index) => tagBranch(root, branchId, index));
  });
  const localEvent = (exprId: HirExprId): LocalEvent | undefined => {
    const position = positions.get(exprId);
    return typeof position === "number"
      ? { position, path: paths.get(exprId) ?? new Map() }
      : undefined;
  };
  const definitions: LocalDefinition[] = [];
  const addPatternDefinitions = (
    pattern: HirPattern,
    value: HirExprId,
    event: LocalEvent,
    projection: readonly PlaceProjection[] = [],
  ): void => {
    if (pattern.kind === "identifier") {
      definitions.push({
        symbol: pattern.symbol,
        value,
        projection,
        event,
      });
      return;
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach((element, index) =>
        addPatternDefinitions(element, value, event, [
          ...projection,
          { kind: "tuple", index },
        ]),
      );
      return;
    }
    if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) =>
        addPatternDefinitions(field.pattern, value, event, [
          ...projection,
          { kind: "field", name: field.name },
        ]),
      );
      return;
    }
    if (pattern.kind === "type" && pattern.binding) {
      addPatternDefinitions(pattern.binding, value, event, projection);
    }
  };
  walkExpression({
    exprId: lambda.body,
    hir: ctx.hir,
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") {
        return;
      }
      const event = localEvent(statement.initializer);
      if (event) {
        addPatternDefinitions(statement.pattern, statement.initializer, {
          ...event,
          position: exitPositions.get(statement.initializer) ?? event.position,
        });
      }
    },
    onEnterExpression: (_exprId, expr) => {
      if (expr.exprKind !== "assign") {
        return;
      }
      const event = localEvent(expr.id);
      if (!event) {
        return;
      }
      if (typeof expr.target === "number") {
        const target = ctx.hir.expressions.get(expr.target);
        if (target?.exprKind === "identifier") {
          definitions.push({
            symbol: target.symbol,
            value: expr.value,
            projection: [],
            event: {
              ...event,
              position: exitPositions.get(expr.value) ?? event.position,
            },
          });
        }
      }
      if (expr.pattern) {
        addPatternDefinitions(expr.pattern, expr.value, {
          ...event,
          position: exitPositions.get(expr.value) ?? event.position,
        });
      }
    },
  });
  const projectionEquals = (
    left: PlaceProjection,
    right: PlaceProjection,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);
  const uniquePaths = (
    paths: readonly (readonly PlaceProjection[])[],
  ): readonly (readonly PlaceProjection[])[] =>
    Array.from(
      new Map(paths.map((path) => [JSON.stringify(path), path])).values(),
    );
  const projectPaths = (
    paths: readonly (readonly PlaceProjection[])[],
    projection: PlaceProjection,
  ): readonly (readonly PlaceProjection[])[] =>
    uniquePaths(
      paths.flatMap((path) => {
        if (path.length === 0) {
          return [[]];
        }
        return projectionEquals(path[0]!, projection) ? [path.slice(1)] : [];
      }),
    );
  const aliasOriginsOf = (
    exprId: HirExprId,
    seen = new Set<HirExprId>(),
  ): readonly (readonly PlaceProjection[])[] => {
    if (seen.has(exprId)) {
      return [];
    }
    seen.add(exprId);
    const expr = ctx.hir.expressions.get(exprId);
    if (!expr) {
      return [];
    }
    if (expr.exprKind === "identifier") {
      if (expr.symbol === symbol) {
        return [[]];
      }
      const useEvent = localEvent(expr.id);
      if (!useEvent) {
        return [];
      }
      const reaching = definitions.filter(
        (definition) =>
          definition.symbol === expr.symbol &&
          definition.event.position <= useEvent.position &&
          pathsCompatible(definition.event.path, useEvent.path) &&
          !definitions.some(
            (candidate) =>
              candidate !== definition &&
              candidate.symbol === expr.symbol &&
              candidate.event.position > definition.event.position &&
              candidate.event.position <= useEvent.position &&
              Array.from(candidate.event.path).every(
                ([branchId, branchIndex]) =>
                  useEvent.path.get(branchId) === branchIndex,
              ),
          ),
      );
      return uniquePaths(
        reaching.flatMap((definition) =>
          definition.projection.reduce(
            (paths, projection) => projectPaths(paths, projection),
            aliasOriginsOf(definition.value, new Set(seen)),
          ),
        ),
      );
    }
    if (expr.exprKind === "field-access") {
      if (!isReferenceLike(typeOfExpr(expr.id, ctx), ctx)) {
        return [];
      }
      const projection = Number.isInteger(Number(expr.field))
        ? ({ kind: "tuple", index: Number(expr.field) } as const)
        : ({ kind: "field", name: expr.field } as const);
      return projectPaths(aliasOriginsOf(expr.target, seen), projection);
    }
    if (expr.exprKind === "tuple") {
      return uniquePaths(
        expr.elements.flatMap((element, index) =>
          isReferenceLike(typeOfExpr(element, ctx), ctx)
            ? aliasOriginsOf(element, new Set(seen)).map((path) => [
                { kind: "tuple", index } as const,
                ...path,
              ])
            : [],
        ),
      );
    }
    if (expr.exprKind === "object-literal") {
      return uniquePaths(
        expr.entries.flatMap((entry) => {
          if (!isReferenceLike(typeOfExpr(entry.value, ctx), ctx)) {
            return [];
          }
          const paths = aliasOriginsOf(entry.value, new Set(seen));
          return entry.kind === "field"
            ? paths.map((path) => [
                { kind: "field", name: entry.name } as const,
                ...path,
              ])
            : paths.length > 0
              ? [[]]
              : [];
        }),
      );
    }
    if (expr.exprKind === "call" || expr.exprKind === "method-call") {
      const info = targetInfo(expr, ctx);
      if (
        intrinsicNameForCall(expr, ctx) === "~" &&
        typeof info.arguments[0] === "number"
      ) {
        return aliasOriginsOf(info.arguments[0], seen);
      }
      return uniquePaths(
        info.contract?.parameters.flatMap((parameter, index) => {
          const actual = info.arguments[index];
          if (!parameter.returned || typeof actual !== "number") {
            return [];
          }
          const actualPaths = aliasOriginsOf(actual, new Set(seen));
          return returnedOrigins(parameter).flatMap((origin) =>
            actualPaths.flatMap((path) => {
              if (path.length === 0) {
                return [origin.result];
              }
              const sharedLength = Math.min(path.length, origin.source.length);
              const sharesPrefix = Array.from(
                { length: sharedLength },
                (_, index) =>
                  projectionEquals(path[index]!, origin.source[index]!),
              ).every(Boolean);
              if (!sharesPrefix) {
                return [];
              }
              return path.length <= origin.source.length
                ? [origin.result]
                : [[...origin.result, ...path.slice(origin.source.length)]];
            }),
          );
        }) ?? [],
      );
    }
    if (expr.exprKind === "block" && typeof expr.value === "number") {
      return aliasOriginsOf(expr.value, seen);
    }
    if (expr.exprKind === "if" || expr.exprKind === "cond") {
      return uniquePaths([
        ...expr.branches.flatMap((branch) =>
          aliasOriginsOf(branch.value, new Set(seen)),
        ),
        ...(typeof expr.defaultBranch === "number"
          ? aliasOriginsOf(expr.defaultBranch, new Set(seen))
          : []),
      ]);
    }
    if (expr.exprKind === "match") {
      return uniquePaths(
        expr.arms.flatMap((arm) => aliasOriginsOf(arm.value, new Set(seen))),
      );
    }
    if (expr.exprKind === "effect-handler") {
      return uniquePaths([
        ...aliasOriginsOf(expr.body, new Set(seen)),
        ...expr.handlers.flatMap((handler) =>
          aliasOriginsOf(handler.body, new Set(seen)),
        ),
      ]);
    }
    return [];
  };
  const aliasesCapture = (exprId: HirExprId): boolean => {
    return aliasOriginsOf(exprId).length > 0;
  };
  walkExpression({
    exprId: lambda.body,
    hir: ctx.hir,
    onEnterExpression: (_exprId, expr) => {
      if (mutable) {
        return { stop: true };
      }
      if (expr.exprKind === "assign") {
        if (typeof expr.target === "number") {
          const target = ctx.hir.expressions.get(expr.target);
          const root = baseSymbolOf(expr.target, ctx);
          const mutatesCapturedProjection =
            target?.exprKind === "field-access" &&
            aliasOriginsOf(target.target).some((origin) => origin.length === 0);
          if (root === symbol || mutatesCapturedProjection) {
            mutable = true;
            return { stop: true };
          }
        }
        return undefined;
      }
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return undefined;
      }
      const info = targetInfo(expr, ctx);
      mutable = info.arguments.some(
        (actual, index) =>
          typeof actual === "number" &&
          aliasesCapture(actual) &&
          parameterAccessFor({ index, actual, info, ctx }) === "mutable",
      );
      return mutable ? { stop: true } : undefined;
    },
  });
  return mutable;
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

const reportExplicitBorrowEscape = ({
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
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0051",
      params: { kind: "explicit-borrow-escape", binding, through },
      span,
      related: [
        diagnosticFromCode({
          code: "TY0051",
          params: { kind: "borrow-origin", binding },
          span: alias?.span ?? span,
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
  const projectedAliases: { symbol: SymbolId; alias: AliasDefinition }[] = [];
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
      const projection = Number.isInteger(Number(expr.field))
        ? ({ kind: "tuple", index: Number(expr.field) } as const)
        : ({ kind: "field", name: expr.field } as const);
      visitAtProjection(expr.target, [projection, ...requested]);
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
        const origins = returnedOrigins(parameter);
        origins.forEach((origin) => {
          const translated = translateProjectionPath({
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
      const event = ctx.events.get(expr.id);
      const reaching = event
        ? reachingAliasDefinitions(expr.symbol, event, ctx)
        : [];
      const projected = reaching.filter((alias) => {
        if (
          alias.conservativeReturnedAggregate ||
          alias.resultProjections === undefined
        ) {
          return true;
        }
        return (
          translateProjectionPath({
            result: alias.resultProjections,
            source: [],
            requested,
          }) !== undefined
        );
      });
      if (reaching.length > 0) {
        projected.forEach((alias) => {
          const normalized =
            alias.conservativeReturnedAggregate ||
            alias.resultProjections === undefined
              ? {
                  ...alias,
                  place: requested.reduce(appendProjection, alias.place),
                  resultProjections: [],
                }
              : requested.reduce<AggregateOrigin | undefined>(
                  (origin, projection) =>
                    origin
                      ? projectAggregateOrigin(origin, projection)
                      : undefined,
                  {
                    place: alias.place,
                    resultProjections: alias.resultProjections,
                    provenance: alias.provenance,
                    access: alias.access,
                    capture: alias.capture,
                  },
                );
          if (normalized) {
            projectedAliases.push({
              symbol: expr.symbol,
              alias: {
                ...alias,
                place: normalized.place,
                resultProjections: normalized.resultProjections,
              },
            });
          }
          if (alias.access === "mutable" && alias.capture === true) {
            captured.push({
              symbol: alias.place.root,
              alias: { ...alias, symbol: alias.place.root, capture: true },
            });
          }
        });
        return;
      }
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
        if (expressionMaterializesPlainProjection(expr.id, ctx)) {
          aggregateOriginsOfExpression(expr.id, ctx)
            .filter((origin) => origin.capture === true)
            .forEach((origin) => {
              visitSymbol(origin.place.root);
              if (origin.access === "mutable") {
                captured.push({
                  symbol: origin.place.root,
                  alias: {
                    symbol: origin.place.root,
                    place: origin.place,
                    access: origin.access,
                    provenance: origin.provenance,
                    capture: true,
                    span: expr.span,
                    event: ctx.events.get(expr.id) ?? {
                      position: ctx.nextPosition,
                      span: expr.span,
                      path: new Map(),
                      loops: new Set(),
                    },
                    uses: [],
                  },
                });
              }
            });
          return;
        }
        visitAtProjection(expr.target, [
          Number.isInteger(Number(expr.field))
            ? { kind: "tuple", index: Number(expr.field) }
            : { kind: "field", name: expr.field },
        ]);
        return;
      case "tuple":
        expr.elements.forEach((element, index) => {
          if (
            !aggregateProjectionMaterializesBorrowedPrimitive(
              expr.id,
              element,
              { kind: "tuple", index },
              ctx,
            )
          ) {
            visit(element);
          }
        });
        return;
      case "object-literal":
        aggregateOriginsOfExpression(expr.id, ctx).forEach((origin) => {
          const event = ctx.events.get(expr.id) ?? {
            position: ctx.nextPosition,
            span: expr.span,
            path: new Map(),
            loops: new Set(),
          };
          projectedAliases.push({
            symbol: origin.place.root,
            alias: {
              symbol: origin.place.root,
              place: origin.place,
              access: origin.access ?? "shared",
              provenance: origin.provenance,
              span: expr.span,
              event,
              uses: [event],
              ...(origin.resultProjections.length > 0
                ? { resultProjections: origin.resultProjections }
                : {}),
              ...(origin.capture === true ? { capture: true } : {}),
            },
          });
        });
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
              const mutableCapture = lambdaMutablyUsesCapture(
                expr,
                capture.symbol,
                ctx,
              );
              captured.push({
                symbol: capture.symbol,
                alias: {
                  ...(source ?? {
                    symbol: capture.symbol,
                    place,
                    access: "shared",
                    provenance: "allocation-alias",
                    span: capture.span,
                    event,
                    uses: [event],
                  }),
                  access: mutableCapture ? "mutable" : "shared",
                  provenance: mutableCapture
                    ? "storage-borrow"
                    : (source?.provenance ?? "allocation-alias"),
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
          const origins = returnedOrigins(parameter);
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
        return;
      default:
        return;
    }
  }
  visit(exprId);
  return [
    ...captured,
    ...projectedAliases,
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
  ctx,
}: {
  exprId: HirExprId;
  span: SourceSpan;
  through: string;
  projectionPaths?: readonly (readonly PlaceProjection[])[];
  ctx: BodyContext;
}): void => {
  const expression = ctx.hir.expressions.get(exprId);
  const expressionType = typeOfExpr(exprId, ctx);
  const expressionDescriptor =
    typeof expressionType === "number"
      ? ctx.typing.arena.get(expressionType)
      : undefined;
  if (
    through === "this return" &&
    ctx.borrowedReturnEntries.length === 0 &&
    expressionDescriptor?.kind === "borrowed" &&
    ctx.typing.arena.get(expressionDescriptor.inner).kind === "primitive"
  ) {
    return;
  }
  const callMaterializesPlainProjection =
    typeof expressionType === "number" &&
    !typeContainsBorrowed(expressionType, ctx.typing) &&
    (expression?.exprKind === "call" ||
      expression?.exprKind === "method-call") &&
    (() => {
      const returned =
        targetInfo(expression, ctx).contract?.parameters.filter(
          (parameter) => parameter.returned === true,
        ) ?? [];
      return (
        returned.length > 0 &&
        returned.every(
          (parameter) =>
            (parameter.returnedOrigins?.length ?? 0) > 0 &&
            parameter.returnedOrigins?.every(
              (origin) => origin.source.length > 0,
            ) === true,
        )
      );
    })();
  escapedPlacesIn(exprId, ctx).forEach(({ symbol, alias }) => {
    if (
      callMaterializesPlainProjection &&
      alias.access === "shared" &&
      alias.capture !== true
    ) {
      return;
    }
    const selectedPlaces = projectionPaths.flatMap((path) => {
      if (alias.conservativeReturnedAggregate) {
        return [alias.place];
      }
      if (!alias.resultProjections) {
        return [path.reduce(appendProjection, alias.place)];
      }
      const translated = translateProjectionPath({
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
    if (alias.access === "mutable") {
      reportMutableEscape({ symbol, span, through, ctx });
      return;
    }
    if (alias.provenance !== "storage-borrow") {
      return;
    }
    const resultPath = alias.resultProjections ?? [];
    const returnAllowsBorrow =
      through === "this return" &&
      ctx.borrowedReturnPaths.some(
        (path) =>
          projectionPathCovers(path, resultPath) ||
          projectionPathCovers(resultPath, path),
      );
    const returnAllowsParametricBorrow =
      through === "this return" &&
      ctx.parameterSymbols.has(alias.place.root) &&
      typeof ctx.returnType === "number" &&
      typeParameterPathsInType(ctx.returnType, ctx.typing).some(
        (path) =>
          projectionPathCovers(path, resultPath) ||
          projectionPathCovers(resultPath, path),
      );
    if (!returnAllowsBorrow && !returnAllowsParametricBorrow) {
      reportExplicitBorrowEscape({ symbol, span, through, ctx });
    }
  });
};

const validateBorrowedReturnOrigins = (
  exprId: HirExprId,
  span: SourceSpan,
  ctx: BodyContext,
): void => {
  if (ctx.borrowedReturnEntries.length === 0) {
    return;
  }
  ctx.borrowedReturnEntries.forEach(({ path, inner }) => {
    borrowFormationLeaves(exprId, ctx).forEach((leaf) => {
      if (!expressionProvidesProjection(leaf, path, ctx)) {
        return;
      }
      const places = placesForBorrowedEntry(leaf, { path, inner }, ctx);
      if (places.length === 0) {
        if (nestedBorrowMayBeAbsentFromCall(leaf, path, ctx)) {
          return;
        }
        addDiagnostic(
          diagnosticFromCode({
            code: "TY0051",
            params: {
              kind: "explicit-borrow-escape",
              binding: "temporary",
              through: "a return without stable origin storage",
            },
            span,
          }),
          ctx,
        );
        return;
      }
      new Set(places.map((place) => place.root)).forEach((root) => {
        const originPlaces = places.filter((place) => place.root === root);
        const rootType = ctx.typing.valueTypes.get(root);
        const originatesInRetainedAllocation =
          typeof rootType === "number" &&
          typeIsAllocationBacked(rootType, ctx.typing) &&
          originPlaces.some((place) => place.projections.length > 0);
        if (
          ctx.parameterSymbols.has(root) &&
          (ctx.borrowedParameterSymbols.has(root) ||
            typeIsAllocationBacked(inner, ctx.typing) ||
            originatesInRetainedAllocation)
        ) {
          return;
        }
        const record = ctx.symbolTable.getSymbol(root);
        if (ctx.symbolTable.getScope(record.scope).kind === "module") {
          return;
        }
        reportExplicitBorrowEscape({
          symbol: root,
          span,
          through: "a return that outlives its local origin",
          ctx,
        });
      });
    });
  });
};

const expressionProvidesProjection = (
  exprId: HirExprId,
  path: readonly PlaceProjection[],
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): boolean => {
  if (path.length === 0) {
    return true;
  }
  if (seen.has(exprId)) {
    return true;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "field-access") {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return expressionProvidesProjection(
      expr.target,
      [projection, ...path],
      ctx,
      new Set(seen),
    );
  }
  if (expr.exprKind === "identifier") {
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? expressionProvidesProjection(initializer, path, ctx, new Set(seen))
      : true;
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return expressionProvidesProjection(expr.value, path, ctx, new Set(seen));
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      expr.branches.some((branch) =>
        expressionProvidesProjection(branch.value, path, ctx, new Set(seen)),
      ) ||
      (typeof expr.defaultBranch === "number" &&
        expressionProvidesProjection(
          expr.defaultBranch,
          path,
          ctx,
          new Set(seen),
        ))
    );
  }
  if (expr.exprKind === "match") {
    return expr.arms.some((arm) =>
      expressionProvidesProjection(arm.value, path, ctx, new Set(seen)),
    );
  }
  if (expr.exprKind === "effect-handler") {
    return (
      expressionProvidesProjection(expr.body, path, ctx, new Set(seen)) ||
      expr.handlers.some((handler) =>
        expressionProvidesProjection(handler.body, path, ctx, new Set(seen)),
      )
    );
  }
  const [projection, ...remaining] = path;
  if (expr.exprKind === "object-literal" && projection?.kind === "field") {
    const provider = objectLiteralProjectionProvider({
      expression: expr,
      projection,
      ctx,
    });
    return provider
      ? expressionProvidesProjection(
          provider.value,
          provider.kind === "spread" ? path : remaining,
          ctx,
          new Set(seen),
        )
      : false;
  }
  if (expr.exprKind === "tuple" && projection?.kind === "tuple") {
    const element = expr.elements[projection.index];
    return typeof element === "number"
      ? expressionProvidesProjection(element, remaining, ctx, new Set(seen))
      : false;
  }
  return true;
};

const isFreshAggregateLiteral = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  return expr?.exprKind === "object-literal" || expr?.exprKind === "tuple";
};

const validateBorrowFormationOrigins = ({
  value,
  expectedType,
  binding,
  through,
  span,
  ctx,
}: {
  value: HirExprId;
  expectedType: TypeId;
  binding: string;
  through: string;
  span: SourceSpan;
  ctx: BodyContext;
}): void => {
  const actualType = typeOfExpr(value, ctx);
  const actualEntries =
    typeof actualType === "number"
      ? borrowedTypeEntriesInType(actualType, ctx.typing)
      : [];
  borrowedTypeEntriesInType(expectedType, ctx.typing).forEach((entry) => {
    const alreadyBorrowed = hasMatchingBorrowedTypeEntry(entry, actualEntries);
    borrowFormationLeaves(value, ctx).forEach((leaf) => {
      const contextualAggregate =
        alreadyBorrowed && isFreshAggregateLiteral(leaf, ctx);
      if (alreadyBorrowed && !contextualAggregate) {
        return;
      }
      if (!expressionProvidesProjection(leaf, entry.path, ctx)) {
        return;
      }
      const places = contextualAggregate
        ? placesAtProjection(leaf, entry.path, ctx, new Set())
        : placesForBorrowFormation(leaf, entry.path, ctx);
      if (
        places.length > 0 ||
        nestedBorrowMayBeAbsentFromCall(leaf, entry.path, ctx)
      ) {
        return;
      }
      addDiagnostic(
        diagnosticFromCode({
          code: "TY0051",
          params: {
            kind: "explicit-borrow-escape",
            binding,
            through,
          },
          span: ctx.hir.expressions.get(leaf)?.span ?? span,
        }),
        ctx,
      );
    });
  });
};

const validateBorrowFormationIntoExistingStorage = ({
  value,
  storageType,
  span,
  through,
  projectionPaths,
  ctx,
}: {
  value: HirExprId;
  storageType: TypeId | undefined;
  span: SourceSpan;
  through: string;
  projectionPaths?: readonly (readonly PlaceProjection[])[];
  ctx: BodyContext;
}): void => {
  if (typeof storageType !== "number") {
    return;
  }
  const leaves = borrowFormationLeaves(value, ctx);
  const storedEntries = borrowedTypeEntriesInType(
    storageType,
    ctx.typing,
  ).filter(
    (entry) =>
      !projectionPaths ||
      projectionPaths.some((path) => projectionPathsOverlap(entry.path, path)),
  );
  if (
    storedEntries.length === 0 ||
    storedEntries.every((entry) =>
      leaves.every((leaf) => {
        const leafType = typeOfExpr(leaf, ctx);
        const leafEntries =
          typeof leafType === "number"
            ? borrowedTypeEntriesInType(leafType, ctx.typing)
            : [];
        return (
          (!isFreshAggregateLiteral(leaf, ctx) &&
            hasMatchingBorrowedTypeEntry(entry, leafEntries)) ||
          !expressionProvidesProjection(leaf, entry.path, ctx)
        );
      }),
    )
  ) {
    return;
  }
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0051",
      params: {
        kind: "explicit-borrow-escape",
        binding: "borrowed value",
        through,
      },
      span,
    }),
    ctx,
  );
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
    return;
  }
  validateBorrowedReturnOrigins(exprId, expr.span, ctx);
  escapeExpression({
    exprId,
    span: expr.span,
    through: "this return",
    ctx,
  });
};

const directPlacesOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return [];
  }
  if (expr.exprKind === "identifier") {
    return [
      ctx.places.get(expr.symbol) ?? {
        root: expr.symbol,
        projections: [],
      },
    ];
  }
  if (expr.exprKind === "field-access") {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return directPlacesOfExpression(expr.target, ctx).map((place) =>
      appendAccessProjections(
        place,
        accessProjectionsFor(expr.target, projection, ctx),
      ),
    );
  }
  if (expr.exprKind === "call" && intrinsicNameForCall(expr, ctx) === "~") {
    const operand = expr.args.at(-1)?.expr;
    return typeof operand === "number"
      ? directPlacesOfExpression(operand, ctx)
      : [];
  }
  return [];
};

const lexicalStoragePlaces = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    return [{ root: expr.symbol, projections: [] }];
  }
  if (expr?.exprKind !== "field-access") {
    return [];
  }
  const projection = Number.isInteger(Number(expr.field))
    ? ({ kind: "tuple", index: Number(expr.field) } as const)
    : ({ kind: "field", name: expr.field } as const);
  const targetType = typeOfExpr(expr.target, ctx);
  const targetDesc =
    typeof targetType === "number"
      ? ctx.typing.arena.get(targetType)
      : undefined;
  const projections =
    typeof targetType === "number" &&
    typeIsAllocationBacked(targetType, ctx.typing) &&
    targetDesc?.kind !== "borrowed"
      ? [{ kind: "dereference" as const }, projection]
      : [projection];
  return lexicalStoragePlaces(expr.target, ctx).map((place) =>
    appendAccessProjections(place, projections),
  );
};

const valueFieldStoragePlaces = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] | undefined => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind !== "field-access") {
    return undefined;
  }
  const target = ctx.hir.expressions.get(expr.target);
  const targetType =
    target?.exprKind === "identifier"
      ? (ctx.typing.valueTypes.get(target.symbol) ??
        typeOfExpr(expr.target, ctx))
      : typeOfExpr(expr.target, ctx);
  if (
    typeof targetType !== "number" ||
    typeIsAllocationBacked(targetType, ctx.typing)
  ) {
    return undefined;
  }
  return lexicalStoragePlaces(exprId, ctx);
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
  const resultType = typeOfExpr(expr.id, ctx);
  if (
    typeof resultType === "number" &&
    typeContainsBorrowed(resultType, ctx.typing) &&
    info.targets.length === 0 &&
    !info.contract?.parameters.some(
      (parameter) => (parameter.returnedSharedOrigins?.length ?? 0) > 0,
    )
  ) {
    addDiagnostic(
      diagnosticFromCode({
        code: "TY0051",
        params: {
          kind: "explicit-borrow-escape",
          binding: "borrowed result",
          through: "an opaque call without borrowed-result provenance",
        },
        span: expr.span,
      }),
      ctx,
    );
  }
  info.signature?.parameters.forEach((parameter, index) => {
    const actual = actuals[index];
    if (typeof actual !== "number") {
      return;
    }
    const actualType = typeOfExpr(actual, ctx);
    const actualDescriptor =
      typeof actualType === "number"
        ? ctx.typing.arena.get(actualType)
        : undefined;
    const parameterDescriptor = ctx.typing.arena.get(parameter.type);
    if (
      actualDescriptor?.kind === "borrowed" &&
      parameterDescriptor.kind !== "borrowed"
    ) {
      const contract = info.contract?.parameters[index];
      const returnsMaterializedProjection =
        contract?.returned === true &&
        typeof info.signature?.returnType === "number" &&
        !typeContainsBorrowed(info.signature.returnType, ctx.typing) &&
        (contract.returnedOrigins?.length ?? 0) > 0 &&
        contract.returnedOrigins?.every(
          (origin) => origin.source.length > 0,
        ) === true;
      const requiresOwnership =
        !contract ||
        contract.access === "mutable" ||
        contract.retained === true ||
        (contract.returned === true && !returnsMaterializedProjection) ||
        (contract.retainedPaths?.length ?? 0) > 0 ||
        (contract.externalRetainedPaths?.length ?? 0) > 0 ||
        (contract.borrowedRetainedPaths?.length ?? 0) > 0;
      if (requiresOwnership && intrinsicName === undefined) {
        addDiagnostic(
          diagnosticFromCode({
            code: "TY0051",
            params: {
              kind: "explicit-borrow-escape",
              binding: "borrowed argument",
              through: "a call that requires ownership or may retain the value",
            },
            span: ctx.hir.expressions.get(actual)?.span ?? expr.span,
          }),
          ctx,
        );
      }
    }
    validateBorrowFormationOrigins({
      value: actual,
      expectedType: parameter.type,
      binding: "temporary",
      through: "a borrowed call argument without stable origin storage",
      span: expr.span,
      ctx,
    });
  });
  type EffectiveActual = {
    index: number;
    actual: HirExprId;
    source: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
    parameter?: CallableParameterBorrowContract;
  };
  const effectiveActuals: readonly EffectiveActual[] = (
    info.contract?.parameters ?? actuals.map(() => undefined)
  ).flatMap((parameter, index) => {
    const actual = actuals[index];
    if (typeof actual === "number") {
      return [{ index, actual, source: [], result: [] }];
    }
    return (parameter?.defaultOrigins ?? []).flatMap((origin) => {
      const defaultActual = actuals[origin.parameter];
      return typeof defaultActual === "number"
        ? [
            {
              index,
              actual: defaultActual,
              source: origin.source,
              result: origin.result,
            },
          ]
        : [];
    });
  });
  const defaultAccessGroups: readonly (readonly EffectiveActual[])[] =
    info.contract?.parameters.map((parameter, index) => {
      if (typeof actuals[index] === "number") {
        return [];
      }
      return [
        ...(parameter.defaultReadOrigins ?? []).map((origin) => ({
          origin,
          access: "shared" as const,
        })),
        ...(parameter.defaultWriteOrigins ?? []).map((origin) => ({
          origin,
          access: "mutable" as const,
        })),
      ].flatMap(({ origin, access }) => {
        const actual = actuals[origin.parameter];
        return typeof actual === "number"
          ? [
              {
                index: origin.parameter,
                actual,
                source: [],
                result: [],
                parameter: {
                  access,
                  ...(access === "shared"
                    ? { readPaths: [origin.path] }
                    : { writePaths: [origin.path] }),
                  retained: false,
                  returned: false,
                },
              },
            ]
          : [];
      });
    }) ?? [];
  validateBorrowedCallbacks(expr, info, ctx);
  const activateAccesses = ({
    actual,
    index,
    source,
    result,
    parameter: parameterOverride,
  }: EffectiveActual) => {
    const parameter = parameterOverride ?? info.contract?.parameters[index];
    const access =
      parameterOverride?.access ??
      parameterAccessFor({ index, actual, info, ctx });
    if (access === "owned") {
      return [];
    }
    const actor = baseSymbolOf(actual, ctx);
    const accesses = parameter
      ? [
          ...(parameter.readPaths ?? []).map((path) => ({
            access: "shared" as const,
            path,
          })),
          ...(parameter.writePaths ?? []).map((path) => ({
            access:
              parameter.access === "mutable" ||
              parameter.runtimeCheckedWrites !== true
                ? ("mutable" as const)
                : ("shared" as const),
            path,
          })),
          ...explicitBorrowAccessPaths(info, index, ctx).map((path) => ({
            access: "shared" as const,
            path,
          })),
        ]
      : [{ access, path: [] as readonly PlaceProjection[] }];
    return accesses.flatMap(({ access: pathAccess, path }) => {
      const actualPath = translateProjectionPath({
        result,
        source,
        requested: path,
      });
      if (!actualPath) {
        return [];
      }
      const directPlaces = directPlacesOfExpression(actual, ctx);
      const places =
        actualPath.some((projection) => projection.kind === "dereference") ||
        directPlaces.length === 0
          ? placesAtProjection(actual, actualPath, ctx, new Set())
          : directPlaces.map((place) =>
              appendAccessProjections(place, actualPath),
            );
      return uniquePlaces(places).map((place) => {
        const actorInitializer =
          typeof actor === "number"
            ? ctx.bindingInitializers.get(actor)
            : undefined;
        const actorIsSharedCellBorrow =
          typeof actorInitializer === "number" &&
          isSharedCellValueExpression(actorInitializer, ctx);
        if (
          access === "mutable" &&
          !actorIsSharedCellBorrow &&
          (typeof actor === "number"
            ? !hasMutableCapabilityAt(actor, event, ctx)
            : !isSharedCellValueExpression(actual, ctx))
        ) {
          reportMutableCapabilityViolation({ place, actor, event, ctx });
        }
        checkAccess({ place, actor, access: pathAccess, event, ctx });
        if (pathAccess === "mutable") {
          ctx.mutableStorageSymbols.add(place.root);
        }
        return { index, actual, place, actor, access: pathAccess };
      });
    });
  };
  const defaultBorrowGroups = defaultAccessGroups.map((group) =>
    group.flatMap(activateAccesses),
  );
  const borrows = effectiveActuals.flatMap(activateAccesses);

  const reportBorrowConflicts = (
    activatedBorrows: readonly (typeof borrows)[number][],
  ): void => {
    activatedBorrows.forEach((left, index) => {
      activatedBorrows.slice(index + 1).forEach((right) => {
        if (left.index === right.index) {
          return;
        }
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
          provenance: "storage-borrow",
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
  };
  defaultBorrowGroups.forEach(reportBorrowConflicts);
  reportBorrowConflicts(borrows);

  effectiveActuals.forEach(({ actual, index, source, result }) => {
    const parameter = info.contract?.parameters[index];
    if (parameter?.retained !== true) {
      return;
    }
    if (intrinsicName === "__array_set" && index === 2) {
      const destination = actuals[0];
      const destinationRoots =
        typeof destination === "number"
          ? new Set(
              placesOfExpression(destination, ctx).map((place) => place.root),
            )
          : new Set<SymbolId>();
      if (
        placesOfExpression(actual, ctx).some((place) =>
          destinationRoots.has(place.root),
        )
      ) {
        return;
      }
    }
    validateBorrowFormationIntoExistingStorage({
      value: actual,
      storageType: info.signature?.parameters[index]?.type,
      span: event.span,
      through: "a retaining call",
      projectionPaths:
        parameter.retainedPaths && parameter.retainedPaths.length > 0
          ? parameter.retainedPaths
          : undefined,
      ctx,
    });
    escapeExpression({
      exprId: actual,
      span: event.span,
      through: "a retaining call",
      projectionPaths:
        parameter.retainedPaths && parameter.retainedPaths.length > 0
          ? parameter.retainedPaths.flatMap((path) => {
              const translated = translateProjectionPath({
                result,
                source,
                requested: path,
              });
              return translated ? [translated] : [];
            })
          : source.length > 0
            ? [source]
            : undefined,
      ctx,
    });
  });
  info.contract?.transfers?.forEach((transfer) => {
    if (
      transfer.sourceInvalidated ||
      (transfer.sourceParameter === transfer.destinationParameter &&
        JSON.stringify(transfer.sourcePath ?? []) ===
          JSON.stringify(transfer.destinationPath ?? []))
    ) {
      return;
    }
    const source = actuals[transfer.sourceParameter];
    const destination = actuals[transfer.destinationParameter];
    const destinationType =
      typeof destination === "number"
        ? typeOfExpr(destination, ctx)
        : undefined;
    const destinationIsCallable = isCallableType(destinationType, ctx);
    const destinationSymbol =
      typeof destination === "number"
        ? baseSymbolOf(destination, ctx)
        : undefined;
    const destinationSymbolType =
      typeof destinationSymbol === "number"
        ? ctx.typing.valueTypes.get(destinationSymbol)
        : undefined;
    const destinationIsCallableParameter =
      typeof destinationSymbol === "number" &&
      ctx.parameterSymbols.has(destinationSymbol) &&
      isCallableType(destinationSymbolType, ctx);
    const callTarget = expr.exprKind === "call" ? expr.callee : expr.target;
    const destinationIsCallTarget =
      typeof destinationSymbol === "number" &&
      baseSymbolOf(callTarget, ctx) === destinationSymbol;
    const destinationIsCallablePayload =
      transfer.destinationPath?.[0]?.kind === "field" &&
      transfer.destinationPath[0].name === "__value";
    if (
      typeof source !== "number" ||
      typeof destination !== "number" ||
      destinationIsCallable ||
      destinationIsCallableParameter ||
      destinationIsCallTarget ||
      destinationIsCallablePayload ||
      transferDestinationIsLocal(destination, ctx)
    ) {
      return;
    }
    if (intrinsicName === "__array_set") {
      const destinationRoots = new Set(
        placesOfExpression(destination, ctx).map((place) => place.root),
      );
      if (
        placesOfExpression(source, ctx).some((place) =>
          destinationRoots.has(place.root),
        )
      ) {
        return;
      }
    }
    validateBorrowFormationIntoExistingStorage({
      value: source,
      storageType: info.signature?.parameters[transfer.sourceParameter]?.type,
      span: event.span,
      through: "storage outside this callable",
      projectionPaths: [transfer.sourcePath ?? []],
      ctx,
    });
    escapeExpression({
      exprId: source,
      span: event.span,
      through: "storage outside this callable",
      projectionPaths: [transfer.sourcePath ?? []],
      ctx,
    });
  });

  if (!callMaySuspend(info, ctx)) {
    return;
  }
  const activeBorrow = [
    ...allAliases(ctx).filter(
      (alias) =>
        (alias.access === "mutable" || alias.provenance === "storage-borrow") &&
        aliasActiveAt(alias, event, ctx),
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
  const activeCallBorrow = borrows.find(
    (borrow) =>
      (borrow.access === "mutable" &&
        info.contract?.parameters[borrow.index]?.access === "mutable") ||
      explicitBorrowAccessPaths(info, borrow.index, ctx).length > 0,
  );
  const borrow =
    activeBorrow ??
    (activeCallBorrow
      ? {
          symbol: activeCallBorrow.actor ?? activeCallBorrow.place.root,
          place: activeCallBorrow.place,
          span:
            ctx.hir.expressions.get(activeCallBorrow.actual)?.span ??
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
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested: path.map((name) =>
              Number.isInteger(Number(name))
                ? ({ kind: "tuple", index: Number(name) } as const)
                : ({ kind: "field", name } as const),
            ),
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
  if (callback.exprKind === "if" || callback.exprKind === "cond") {
    return mergeCallableValueResolutions([
      ...callback.branches.map((branch) =>
        callableValueAtPath(branch.value, ctx, path, new Set(seen)),
      ),
      ...(typeof callback.defaultBranch === "number"
        ? [
            callableValueAtPath(
              callback.defaultBranch,
              ctx,
              path,
              new Set(seen),
            ),
          ]
        : [{ kind: "unknown" as const }]),
    ]);
  }
  if (callback.exprKind === "match") {
    return mergeCallableValueResolutions(
      callback.arms.map((arm) =>
        callableValueAtPath(arm.value, ctx, path, new Set(seen)),
      ),
    );
  }
  if (callback.exprKind === "effect-handler") {
    return mergeCallableValueResolutions([
      callableValueAtPath(callback.body, ctx, path, new Set(seen)),
      ...callback.handlers.map((handler) =>
        callableValueAtPath(handler.body, ctx, path, new Set(seen)),
      ),
    ]);
  }
  if (callback.exprKind === "block" && typeof callback.value === "number") {
    return callableValueAtPath(callback.value, ctx, path, seen);
  }
  if (callback.exprKind === "field-access") {
    return callableValueAtPath(
      callback.target,
      ctx,
      [callback.field, ...path],
      seen,
    );
  }
  if (path.length > 0) {
    const [field, ...remaining] = path;
    if (callback.exprKind === "tuple") {
      const index = Number(field);
      const element = Number.isInteger(index)
        ? callback.elements[index]
        : undefined;
      return typeof element === "number"
        ? callableValueAtPath(element, ctx, remaining, seen)
        : { kind: "unknown" };
    }
    if (callback.exprKind !== "object-literal") {
      return { kind: "unknown" };
    }
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
    if (
      !unknown &&
      !borrowed?.retained &&
      !borrowed?.returned &&
      !borrowed?.borrowedRetainedPaths
    ) {
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
                const sourceIsSharedCellBorrow = isSharedCellValueExpression(
                  statement.initializer,
                  ctx,
                );
                if (!sourceMutable && !sourceIsSharedCellBorrow) {
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
            validateBorrowedReturnOrigins(statement.value, statement.span, ctx);
            escapeExpression({
              exprId: statement.value,
              span: statement.span,
              through: "this return",
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
          checkAccess({
            place: ctx.places.get(target.symbol) ?? {
              root: target.symbol,
              projections: [],
            },
            actor: target.symbol,
            access: "mutable",
            event,
            ctx,
          });
          return;
        }
        const actor = baseSymbolOf(targetId, ctx);
        const targetPlaces =
          valueFieldStoragePlaces(targetId, ctx) ??
          placesOfExpression(targetId, ctx);
        targetPlaces.forEach((place) => {
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
          const targetType = typeOfExpr(targetId, ctx);
          validateBorrowFormationIntoExistingStorage({
            value: expr.value,
            storageType: targetType,
            span: expr.span,
            through: "borrow formation into pre-existing field storage",
            ctx,
          });
          if (
            !expressionMaterializesBorrowedPrimitive(
              expr.value,
              [targetType],
              ctx,
            )
          ) {
            escapeExpression({
              exprId: expr.value,
              span: expr.span,
              through: "field storage",
              ctx,
            });
          }
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

const initializeCallableContext = ({
  callable,
  parameterTypes,
  returnType,
  borrowedReturnEntries,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  mutableStorageSymbols,
  diagnostics,
}: {
  callable: BorrowCallable;
  parameterTypes: readonly (TypeId | undefined)[];
  returnType?: TypeId;
  borrowedReturnEntries: readonly BorrowedTypeEntry[];
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  mutableStorageSymbols: Set<SymbolId>;
  diagnostics: Diagnostic[];
}): BodyContext => {
  const places = new Map<SymbolId, BorrowPlace>();
  const aliases = new Map<SymbolId, AliasDefinition>();
  const parameterBorrowAliases: AliasDefinition[] = [];
  const borrowedParameterSymbols = new Set<SymbolId>();
  const mutableOwners = new Set<SymbolId>();
  const mutableParameters = new Set<SymbolId>();
  callable.parameters.forEach((parameter, index) => {
    patternSymbols(parameter.pattern).forEach((symbol) => {
      places.set(symbol, { root: symbol, projections: [] });
      if (parameter.pattern.bindingKind === "mutable-ref") {
        mutableOwners.add(symbol);
        mutableParameters.add(symbol);
      }
      const type = parameterTypes[index];
      if (typeof type !== "number") {
        return;
      }
      const borrowedEntries = borrowedTypeEntriesInType(type, typing);
      if (borrowedEntries.length > 0) {
        borrowedParameterSymbols.add(symbol);
      }
      borrowedEntries.forEach(({ path, inner }) => {
        const event: Event = {
          position: 0,
          span: parameter.span,
          path: new Map(),
          loops: new Set(),
        };
        const alias: AliasDefinition = {
          symbol,
          place: [
            ...path,
            ...(borrowedEndpointIsDereferenced(inner, typing)
              ? ([{ kind: "dereference" }] as const)
              : []),
          ].reduce(appendProjection, { root: symbol, projections: [] }),
          access: "shared",
          provenance: "storage-borrow",
          span: parameter.span,
          event,
          uses: [],
          resultProjections: path,
        };
        if (!aliases.has(symbol)) {
          aliases.set(symbol, alias);
        } else {
          parameterBorrowAliases.push(alias);
        }
      });
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
    aliases,
    assignmentAliases: parameterBorrowAliases,
    reassignments: [],
    places,
    mutableOwners,
    events: new Map(),
    uses: new Map(),
    usePlaces: new Map(),
    mutableStorageSymbols,
    diagnostics,
    terminations: [],
    mutableParameters,
    closureCaptures: new Map(),
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    unknownCallableBindings: new Set(),
    parameterSymbols: new Set(
      callable.parameters.flatMap((parameter) =>
        patternSymbols(parameter.pattern),
      ),
    ),
    borrowedParameterSymbols,
    borrowedReturnEntries,
    borrowedReturnPaths: Array.from(
      new Map(
        borrowedReturnEntries.map(({ path }) => [JSON.stringify(path), path]),
      ).values(),
    ),
    returnType,
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
    new Set(origins.map((origin) => origin.parameter)).forEach(
      (sourceIndex) => {
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
      },
    );
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
  mutableStorageSymbols,
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
  mutableStorageSymbols: Set<SymbolId>;
  diagnostics: Diagnostic[];
}): void => {
  const signature = typing.functions.getSignature(functionItem.symbol);
  analyzeCallableBorrowing({
    callable: functionItem,
    parameterTypes:
      signature?.parameters.map((parameter) => parameter.type) ?? [],
    returnType: signature?.returnType,
    borrowedReturnEntries:
      typeof signature?.returnType === "number"
        ? borrowedTypeEntriesInType(signature.returnType, typing)
        : [],
    contract: contracts.get(functionItem.symbol),
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    mutableStorageSymbols,
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
  mutableStorageSymbols,
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
  mutableStorageSymbols: Set<SymbolId>;
  diagnostics: Diagnostic[];
}): void => {
  const lambdaType = typing.resolvedExprTypes.get(lambda.id);
  const lambdaDescriptor =
    typeof lambdaType === "number" ? typing.arena.get(lambdaType) : undefined;
  analyzeCallableBorrowing({
    callable: lambda,
    parameterTypes:
      lambdaDescriptor?.kind === "function"
        ? lambdaDescriptor.parameters.map((parameter) => parameter.type)
        : [],
    returnType:
      lambdaDescriptor?.kind === "function"
        ? lambdaDescriptor.returnType
        : undefined,
    borrowedReturnEntries:
      lambdaDescriptor?.kind === "function"
        ? borrowedTypeEntriesInType(lambdaDescriptor.returnType, typing)
        : [],
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
    mutableStorageSymbols,
    diagnostics,
  });
};

const analyzeCallableBorrowing = ({
  callable,
  parameterTypes,
  returnType,
  borrowedReturnEntries,
  contract,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  contracts,
  mutableStorageSymbols,
  diagnostics,
}: {
  callable: BorrowCallable;
  parameterTypes: readonly (TypeId | undefined)[];
  returnType?: TypeId;
  borrowedReturnEntries: readonly BorrowedTypeEntry[];
  contract?: CallableBorrowContract;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  mutableStorageSymbols: Set<SymbolId>;
  diagnostics: Diagnostic[];
}): void => {
  const ctx = initializeCallableContext({
    callable,
    parameterTypes,
    returnType,
    borrowedReturnEntries,
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    contracts,
    mutableStorageSymbols,
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
  callable.parameters.forEach((parameter, index) => {
    if (
      typeof parameter.defaultValue !== "number" ||
      typeof parameterTypes[index] !== "number"
    ) {
      return;
    }
    const symbol = patternSymbols(parameter.pattern)[0];
    validateBorrowFormationOrigins({
      value: parameter.defaultValue,
      expectedType: parameterTypes[index],
      binding:
        typeof symbol === "number"
          ? ctx.symbolTable.getSymbol(symbol).name
          : `parameter ${index + 1}`,
      through: "a borrowed parameter default without stable origin storage",
      span:
        ctx.hir.expressions.get(parameter.defaultValue)?.span ?? parameter.span,
      ctx,
    });
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
    alias.uses = uses.filter((use) => {
      const loopCarried = definitionCanReachOnLoopBackedge(
        alias.event,
        use,
        ctx,
      );
      if (use.position < alias.event.position && !loopCarried) {
        return false;
      }
      if (loopCarried) {
        return true;
      }
      const places = ctx.usePlaces.get(symbol)?.get(use);
      return (
        places === undefined ||
        places.some((place) => place.root === symbol) ||
        places.some((place) => placeOverlaps(alias.place, place))
      );
    });
    if (alias.access === "mutable") {
      mutableStorageSymbols.add(alias.place.root);
    }
  });
  callable.parameters.forEach((parameter) => {
    if (typeof parameter.defaultValue === "number") {
      validateExpression(parameter.defaultValue, ctx);
    }
  });
  validateExpression(callable.body, ctx);
  escapeImplicitReturnValues(callable.body, ctx);

  contract?.parameters.forEach((parameter, index) => {
    if (!parameter.borrowedRetainedPaths) {
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
