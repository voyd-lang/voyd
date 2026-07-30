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
  RuntimeIdentityGuard,
} from "./model.js";
import {
  callableContractAllowsRuntimeIdentityGuards,
  callableDefaultsPreserveRuntimeIdentity,
  mergeCallableBorrowContracts,
  projectionPathCovers,
  projectionPathsOverlap,
  runtimeIdentityGuardParameterCanEscape,
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
import { traitRegionProjectionsForCoercion } from "./trait-region-projection.js";
import { isPrivateSummaryRegionProjection } from "./callable-summary.js";

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
  callableResult?: boolean;
  externalResult?: boolean;
  conservativeReturnedAggregate?: boolean;
  resultProjections?: readonly PlaceProjection[];
  capture?: boolean;
  plainIdentity?: true;
  contractSource?: SourceSpan;
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
  assignmentAliasesBySymbol: Map<SymbolId, AliasDefinition[]>;
  reassignments: {
    symbol: SymbolId;
    event: Event;
    initializer?: HirExprId;
  }[];
  reassignmentsBySymbol: Map<
    SymbolId,
    {
      symbol: SymbolId;
      event: Event;
      initializer?: HirExprId;
    }[]
  >;
  places: Map<SymbolId, BorrowPlace>;
  mutableOwners: Set<SymbolId>;
  events: Map<HirExprId, Event>;
  uses: Map<SymbolId, Event[]>;
  usePlaces: Map<SymbolId, Map<Event, readonly BorrowPlace[]>>;
  moduleStorageSymbols: ReadonlySet<SymbolId>;
  mutableStorageSymbols: Set<SymbolId>;
  runtimeIdentityGuards: Map<HirExprId, RuntimeIdentityGuard[]>;
  diagnostics: Diagnostic[];
  terminations: Termination[];
  mutableParameters: ReadonlySet<SymbolId>;
  closureCaptures: Map<SymbolId, readonly SymbolId[]>;
  bindingInitializers: Map<SymbolId, HirExprId>;
  initialBindingInitializers: Map<SymbolId, HirExprId>;
  externalizedPlaces: {
    place: BorrowPlace;
    event: Event;
  }[];
  freshnessInvalidations: {
    place: BorrowPlace;
    event: Event;
  }[];
  callResolutionCache: Map<HirExprId, ResolvedBorrowCall>;
  externalResultCache: Map<string, boolean>;
  expressionPlacesCache: Map<HirExprId, readonly BorrowPlace[]>;
  expressionPlacesInProgress: Set<HirExprId>;
  projectedPlacesCache: Map<string, readonly BorrowPlace[]>;
  projectedPlacesInProgress: Set<string>;
  escapedPlacesCache: Map<
    HirExprId,
    readonly { symbol: SymbolId; alias: AliasDefinition }[]
  >;
  validatedExpressions: Set<string>;
  analysisComplete: boolean;
  completedAliases?: readonly AliasDefinition[];
  completedAliasesByRoot: Map<SymbolId, AliasDefinition[]>;
  aliasRootLocality: Map<SymbolId, boolean>;
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

const normalizeMutableAliasPlace = ({
  place,
  sourceType,
  mutable,
  ctx,
}: {
  place: BorrowPlace;
  sourceType: TypeId | undefined;
  mutable: boolean;
  ctx: Pick<BodyContext, "typing">;
}): BorrowPlace =>
  mutable &&
  typeof sourceType === "number" &&
  typeIsAllocationBacked(sourceType, ctx.typing)
    ? applyBorrowEndpoint(place, "dereferenced")
    : place;

const translateBorrowOriginPath = ({
  result,
  source,
  requested,
  endpointAccess,
}: {
  result: readonly PlaceProjection[];
  source: readonly PlaceProjection[];
  requested: readonly PlaceProjection[];
  endpointAccess?: ReturnedBorrowOrigin["endpointAccess"];
}): readonly PlaceProjection[] | undefined => {
  const translated = translateProjectionPath({ result, source, requested });
  if (!translated || endpointAccess !== "dereferenced") {
    return translated;
  }
  return appendAccessProjections({ root: 0, projections: source }, [
    { kind: "dereference" },
    ...translated.slice(Math.min(source.length, translated.length)),
  ]).projections;
};

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

const borrowContractSourceOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): SourceSpan | undefined => {
  if (seen.has(exprId)) {
    return undefined;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return targetInfo(expr, ctx).contractSources[0];
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const aliasSource = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx).find(
          (alias) => alias.contractSource,
        )?.contractSource
      : undefined;
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return (
      aliasSource ??
      (typeof initializer === "number"
        ? borrowContractSourceOfExpression(initializer, ctx, seen)
        : undefined)
    );
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return borrowContractSourceOfExpression(expr.value, ctx, seen);
  }
  if (expr.exprKind === "field-access") {
    return borrowContractSourceOfExpression(expr.target, ctx, seen);
  }
  return undefined;
};

const reachingAliasDefinitions = (
  symbol: SymbolId,
  event: Event,
  ctx: BodyContext,
): readonly AliasDefinition[] => {
  const primary = ctx.aliases.get(symbol);
  const aliases = [
    ...(primary ? [primary] : []),
    ...(ctx.assignmentAliasesBySymbol.get(symbol) ?? []),
  ];
  const candidateEvents = [
    ...aliases.map((candidate) => candidate.event),
    ...(ctx.reassignmentsBySymbol.get(symbol) ?? []).map(
      (candidate) => candidate.event,
    ),
  ];
  const latestReachingDefinitionPosition = latestDefinitelyReachingPosition(
    candidateEvents,
    event,
  );
  return aliases.filter((alias) => {
    if (
      alias.symbol !== symbol ||
      alias.event.position > event.position ||
      !pathsCompatible(alias.event.path, event.path) ||
      definitionEndsBefore(alias.event, event, ctx)
    ) {
      return false;
    }
    return alias.event.position >= latestReachingDefinitionPosition;
  });
};

const latestDefinitelyReachingPosition = (
  candidates: readonly Event[],
  use: Event,
): number =>
  candidates.reduce(
    (latest, candidate) =>
      candidate.position <= use.position && definitelyReaches(candidate, use)
        ? Math.max(latest, candidate.position)
        : latest,
    -1,
  );

const addAssignmentAlias = (alias: AliasDefinition, ctx: BodyContext): void => {
  ctx.assignmentAliases.push(alias);
  const aliases = ctx.assignmentAliasesBySymbol.get(alias.symbol) ?? [];
  aliases.push(alias);
  ctx.assignmentAliasesBySymbol.set(alias.symbol, aliases);
};

const addReassignment = (
  reassignment: BodyContext["reassignments"][number],
  ctx: BodyContext,
): void => {
  ctx.reassignments.push(reassignment);
  const reassignments =
    ctx.reassignmentsBySymbol.get(reassignment.symbol) ?? [];
  reassignments.push(reassignment);
  ctx.reassignmentsBySymbol.set(reassignment.symbol, reassignments);
};

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

const computePlacesOfExpression = (
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
    if (
      metadata.intrinsic === true &&
      intrinsicName === "__array_get" &&
      expr.args[0] &&
      expr.args[1]
    ) {
      const target = expr.args[0].expr;
      const targets = placesOfExpression(target, ctx, seen);
      const projections = accessProjectionsFor(
        target,
        {
          kind: "index",
          constant: numericConstant(expr.args[1].expr, ctx),
          stable: hasStableIndexedStorage(target, ctx),
        },
        ctx,
      );
      return hasConservativeReturnedAggregate(target, ctx)
        ? targets
        : targets.map((place) =>
            appendExpressionAccess(place, target, projections, ctx),
          );
    }
  }
  const info = targetInfo(expr, ctx);
  return returnedPlacesForCall(info, [], ctx, seen);
};

const placesOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): readonly BorrowPlace[] => {
  if (!ctx.analysisComplete) {
    return computePlacesOfExpression(exprId, ctx, seen);
  }
  if (seen.has(exprId)) {
    return [];
  }
  const cached = ctx.expressionPlacesCache.get(exprId);
  if (cached) {
    return cached;
  }
  if (ctx.expressionPlacesInProgress.has(exprId)) {
    return [];
  }
  ctx.expressionPlacesInProgress.add(exprId);
  try {
    const places = computePlacesOfExpression(exprId, ctx, new Set());
    ctx.expressionPlacesCache.set(exprId, places);
    return places;
  } finally {
    ctx.expressionPlacesInProgress.delete(exprId);
  }
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

const externalReturnedOriginsByContract = new WeakMap<
  CallableBorrowContract,
  NonNullable<CallableBorrowContract["externalReturnedOrigins"]>
>();

const externalReturnedOriginsForCall = (
  info: ResolvedBorrowCall,
): NonNullable<CallableBorrowContract["externalReturnedOrigins"]> => {
  if (!info.contract) {
    return [];
  }
  const cached = externalReturnedOriginsByContract.get(info.contract);
  if (cached) {
    return cached;
  }
  const origins = Array.from(
    new Map(
      (info.contract.externalReturnedOrigins ?? []).map((origin) => [
        JSON.stringify(origin),
        origin,
      ]),
    ).values(),
  );
  externalReturnedOriginsByContract.set(info.contract, origins);
  return origins;
};

const callOriginSourceNeedsDereference = ({
  info,
  parameterIndex,
  source,
  result,
  requested,
  ctx,
}: {
  info: ResolvedBorrowCall;
  parameterIndex: number;
  source: readonly PlaceProjection[];
  result: readonly PlaceProjection[];
  requested: readonly PlaceProjection[];
  ctx: BodyContext;
}): boolean => {
  if (source.length === 0 || requested.length <= result.length) {
    return false;
  }
  const parameterType = info.signature?.parameters[parameterIndex]?.type;
  return (
    typeof parameterType === "number" &&
    projectedTypes(parameterType, source, ctx.typing).some(
      (type) =>
        ctx.typing.arena.get(type).kind !== "borrowed" &&
        typeIsAllocationBacked(type, ctx.typing),
    )
  );
};

const translateCallOriginPath = ({
  info,
  parameterIndex,
  origin,
  requested,
  ctx,
  endpointAccess = origin.endpointAccess,
}: {
  info: ResolvedBorrowCall;
  parameterIndex: number;
  origin: {
    source: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
    endpointAccess?: ReturnedBorrowOrigin["endpointAccess"];
  };
  requested: readonly PlaceProjection[];
  ctx: BodyContext;
  endpointAccess?: ReturnedBorrowOrigin["endpointAccess"];
}): readonly PlaceProjection[] | undefined =>
  translateBorrowOriginPath({
    result: origin.result,
    source: origin.source,
    requested,
    endpointAccess:
      endpointAccess === "dereferenced" ||
      callOriginSourceNeedsDereference({
        info,
        parameterIndex,
        source: origin.source,
        result: origin.result,
        requested,
        ctx,
      })
        ? "dereferenced"
        : endpointAccess,
  });

const effectivePlacesForCallParameter = ({
  info,
  parameterIndex,
  requested,
  ctx,
  seenExpressions,
  seenParameters = new Set<number>(),
}: {
  info: ResolvedBorrowCall;
  parameterIndex: number;
  requested: readonly PlaceProjection[];
  ctx: BodyContext;
  seenExpressions: Set<HirExprId>;
  seenParameters?: Set<number>;
}): readonly BorrowPlace[] => {
  const actual = info.arguments[parameterIndex];
  if (typeof actual === "number") {
    const expression = ctx.hir.expressions.get(actual);
    const projectedActual =
      expression?.exprKind === "call" &&
      intrinsicNameForCall(expression, ctx) === "~"
        ? expression.args.at(-1)?.expr
        : actual;
    return typeof projectedActual === "number"
      ? placesAtProjection(projectedActual, requested, ctx, seenExpressions)
      : [];
  }
  if (seenParameters.has(parameterIndex)) {
    return [];
  }
  seenParameters.add(parameterIndex);
  const parameter = info.contract?.parameters[parameterIndex];
  const defaultPlaces =
    parameter?.defaultOrigins?.flatMap((origin) => {
      const translated = translateCallOriginPath({
        info,
        parameterIndex: origin.parameter,
        origin,
        requested,
        ctx,
      });
      if (!translated) {
        return [];
      }
      return effectivePlacesForCallParameter({
        info,
        parameterIndex: origin.parameter,
        requested: translated,
        ctx,
        seenExpressions: new Set(seenExpressions),
        seenParameters: new Set(seenParameters),
      });
    }) ?? [];
  const root = info.target?.symbol ?? info.targets[0]?.symbol;
  const externalPlaces =
    typeof root !== "number"
      ? []
      : (parameter?.defaultExternalOrigins ?? []).flatMap((origin) => {
          if (origin.fresh) {
            return [];
          }
          const translated = translateBorrowOriginPath({
            result: origin.result,
            source: [],
            requested,
            endpointAccess: origin.endpointAccess,
          });
          return translated
            ? [
                {
                  root,
                  projections: translated,
                },
              ]
            : [];
        });
  return uniquePlaces([...defaultPlaces, ...externalPlaces]);
};

const returnedPlacesForCall = (
  info: ResolvedBorrowCall,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
  seen: Set<HirExprId>,
): readonly BorrowPlace[] =>
  uniquePlaces([
    ...(info.contract?.parameters.flatMap((parameter, index) => {
      if (!parameter.returned) {
        return [];
      }
      const origins = returnedOrigins(parameter);
      return origins.flatMap((origin) => {
        const translated = translateCallOriginPath({
          info,
          parameterIndex: index,
          origin,
          requested,
          ctx,
          endpointAccess: specializedReturnedEndpoint(info, index, origin, ctx),
        });
        if (!translated) {
          return [];
        }
        return effectivePlacesForCallParameter({
          info,
          parameterIndex: index,
          requested: translated,
          ctx,
          seenExpressions: new Set(seen),
        });
      });
    }) ?? []),
    ...externalReturnedOriginsForCall(info).flatMap((origin) => {
      if (origin.fresh) {
        return [];
      }
      const root = info.target?.symbol ?? info.targets[0]?.symbol;
      if (typeof root !== "number") {
        return [];
      }
      const translated = translateBorrowOriginPath({
        result: origin.result,
        source: [],
        requested,
        endpointAccess: origin.endpointAccess,
      });
      if (!translated) {
        return [];
      }
      return [{ root, projections: translated }];
    }),
  ]);

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

const expressionIsExternalStorage = (
  candidate: HirExprId,
  ctx: BodyContext,
  seen = new Set<HirExprId>(),
): boolean => {
  if (seen.has(candidate)) {
    return false;
  }
  seen.add(candidate);
  const expression = ctx.hir.expressions.get(candidate);
  if (expression?.exprKind === "identifier") {
    const localModuleStorage = ctx.moduleStorageSymbols.has(expression.symbol);
    const imported = ctx.imports.get(expression.symbol);
    const importedStorage =
      imported !== undefined &&
      !ctx.dependencies
        .get(imported.moduleId)
        ?.callables.has(imported.symbol) &&
      !ctx.dependencies
        .get(imported.moduleId)
        ?.effectOperations.has(imported.symbol);
    return localModuleStorage || importedStorage;
  }
  if (expression?.exprKind === "field-access") {
    return expressionIsExternalStorage(expression.target, ctx, seen);
  }
  if (
    expression?.exprKind === "call" &&
    intrinsicNameForCall(expression, ctx) === "~"
  ) {
    const operand = expression.args.at(-1)?.expr;
    return typeof operand === "number"
      ? expressionIsExternalStorage(operand, ctx, seen)
      : false;
  }
  return false;
};

const computeExpressionReturnsExternalResult = (
  exprId: HirExprId,
  ctx: BodyContext,
  requested: readonly PlaceProjection[] = [],
  seen = new Set<HirExprId>(),
): boolean => {
  if (seen.has(exprId)) {
    return false;
  }
  seen.add(exprId);
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    if (expr.exprKind === "call" && intrinsicNameForCall(expr, ctx) === "~") {
      const operand = expr.args.at(-1)?.expr;
      return typeof operand === "number"
        ? computeExpressionReturnsExternalResult(operand, ctx, requested, seen)
        : false;
    }
    const info = targetInfo(expr, ctx);
    const hasUnconditionalExternalResult = externalReturnedOriginsForCall(
      info,
    ).some(
      (origin) =>
        origin.fresh !== true &&
        requested.length >= origin.result.length &&
        translateProjectionPath({
          result: origin.result,
          source: [],
          requested,
        }) !== undefined,
    );
    if (hasUnconditionalExternalResult) {
      return true;
    }
    const parameterProjectionIsExternal = (
      parameterIndex: number,
      parameterRequested: readonly PlaceProjection[],
      seenParameters = new Set<number>(),
    ): boolean => {
      const actual = info.arguments[parameterIndex];
      if (typeof actual === "number") {
        return (
          expressionIsExternalStorage(actual, ctx) ||
          computeExpressionReturnsExternalResult(
            actual,
            ctx,
            parameterRequested,
            new Set(seen),
          )
        );
      }
      if (seenParameters.has(parameterIndex)) {
        return false;
      }
      seenParameters.add(parameterIndex);
      const parameter = info.contract?.parameters[parameterIndex];
      if (
        parameter?.defaultExternalOrigins?.some(
          (origin) =>
            origin.fresh !== true &&
            parameterRequested.length >= origin.result.length &&
            translateProjectionPath({
              result: origin.result,
              source: [],
              requested: parameterRequested,
            }) !== undefined,
        )
      ) {
        return true;
      }
      return (
        parameter?.defaultOrigins?.some((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested: parameterRequested,
          });
          return (
            translated !== undefined &&
            parameterProjectionIsExternal(
              origin.parameter,
              translated,
              new Set(seenParameters),
            )
          );
        }) ?? false
      );
    };
    return (
      info.contract?.parameters.some((parameter, index) => {
        if (!parameter.returned) {
          return false;
        }
        return returnedOrigins(parameter).some((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          return (
            translated !== undefined &&
            parameterProjectionIsExternal(index, translated)
          );
        });
      }) ?? false
    );
  }
  if (expr.exprKind === "field-access") {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return computeExpressionReturnsExternalResult(
      expr.target,
      ctx,
      [projection, ...requested],
      seen,
    );
  }
  if (expr.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    if (
      event &&
      reachingAliasDefinitions(expr.symbol, event, ctx).some(
        (alias) =>
          alias.externalResult === true &&
          (alias.resultProjections === undefined
            ? true
            : requested.length >= alias.resultProjections.length &&
              translateProjectionPath({
                result: alias.resultProjections,
                source: [],
                requested,
              }) !== undefined),
      )
    ) {
      return true;
    }
    const initializer = ctx.bindingInitializers.get(expr.symbol);
    return typeof initializer === "number"
      ? computeExpressionReturnsExternalResult(
          initializer,
          ctx,
          requested,
          seen,
        )
      : false;
  }
  if (expr.exprKind === "block" && typeof expr.value === "number") {
    return computeExpressionReturnsExternalResult(
      expr.value,
      ctx,
      requested,
      seen,
    );
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return [
      ...expr.branches.map((branch) => branch.value),
      ...(typeof expr.defaultBranch === "number" ? [expr.defaultBranch] : []),
    ].some((value) =>
      computeExpressionReturnsExternalResult(
        value,
        ctx,
        requested,
        new Set(seen),
      ),
    );
  }
  if (expr.exprKind === "match") {
    return expr.arms.some((arm) =>
      computeExpressionReturnsExternalResult(
        arm.value,
        ctx,
        requested,
        new Set(seen),
      ),
    );
  }
  return false;
};

const expressionReturnsExternalResult = (
  exprId: HirExprId,
  ctx: BodyContext,
  requested: readonly PlaceProjection[] = [],
): boolean => {
  if (!ctx.analysisComplete) {
    return computeExpressionReturnsExternalResult(exprId, ctx, requested);
  }
  const key = `${exprId}:${JSON.stringify(requested)}`;
  const cached = ctx.externalResultCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = computeExpressionReturnsExternalResult(exprId, ctx, requested);
  ctx.externalResultCache.set(key, result);
  return result;
};

const externalResultAccessHint = (
  exprId: HirExprId,
  ctx: BodyContext,
  requested: readonly PlaceProjection[] = [],
): boolean | undefined => {
  if (expressionReturnsExternalResult(exprId, ctx, requested)) {
    return true;
  }
  if (expressionIsExternalStorage(exprId, ctx)) {
    return true;
  }
  if (requested.length > 0) {
    return false;
  }
  const expr = ctx.hir.expressions.get(exprId);
  return expr?.exprKind === "field-access" ||
    expr?.exprKind === "call" ||
    expr?.exprKind === "method-call"
    ? false
    : undefined;
};

const expressionMaterializesPlainProjection = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const expression = ctx.hir.expressions.get(exprId);
  const type = typeOfExpr(exprId, ctx);
  if (
    !expression ||
    typeof type !== "number" ||
    typeContainsBorrowed(type, ctx.typing)
  ) {
    return false;
  }
  if (
    expression.exprKind === "field-access" ||
    expression.exprKind === "object-literal" ||
    expression.exprKind === "tuple"
  ) {
    return true;
  }
  if (expression.exprKind === "call" || expression.exprKind === "method-call") {
    const info = targetInfo(expression, ctx);
    return (
      hasConservativeReturnedAggregate(exprId, ctx) ||
      (info.openTraitDispatch !== true &&
        !ctx.typing.callTraitDispatches.has(exprId) &&
        (expression.exprKind === "method-call" ||
          intrinsicNameForCall(expression, ctx) === undefined) &&
        !expressionCarriesBorrowedProvenance(exprId, ctx))
    );
  }
  if (expression.exprKind === "block" && typeof expression.value === "number") {
    return expressionMaterializesPlainProjection(expression.value, ctx);
  }
  if (expression.exprKind === "if" || expression.exprKind === "cond") {
    const values = [
      ...expression.branches.map((branch) => branch.value),
      ...(typeof expression.defaultBranch === "number"
        ? [expression.defaultBranch]
        : []),
    ];
    return (
      values.length > 0 &&
      values.every((value) => expressionMaterializesPlainProjection(value, ctx))
    );
  }
  if (expression.exprKind === "match") {
    return (
      expression.arms.length > 0 &&
      expression.arms.every((arm) =>
        expressionMaterializesPlainProjection(arm.value, ctx),
      )
    );
  }
  if (expression.exprKind === "effect-handler") {
    return [
      expression.body,
      ...expression.handlers.map((handler) => handler.body),
    ].every((value) => expressionMaterializesPlainProjection(value, ctx));
  }
  return false;
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
    if (expr.exprKind === "call" && intrinsicNameForCall(expr, ctx) === "~") {
      const operand = expr.args.at(-1)?.expr;
      return typeof operand === "number"
        ? expressionProjectionCarriesBorrowedProvenance(
            operand,
            requested,
            ctx,
            seen,
          )
        : false;
    }
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
    const info = targetInfo(expr, ctx);
    return (
      requestedCarriesBorrow &&
      (info.contract?.parameters.some((parameter, index) =>
        parameter.returnedSharedOrigins?.some(
          (origin) =>
            !(
              typeof info.arguments[index] !== "number" &&
              origin.defaultNoBorrow
            ) &&
            translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested,
            }) !== undefined,
        ),
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
  if (expr.exprKind === "field-access") {
    const projection = Number.isInteger(Number(expr.field))
      ? ({ kind: "tuple", index: Number(expr.field) } as const)
      : ({ kind: "field", name: expr.field } as const);
    return projectedReturnedPlaces(
      expr.target,
      [projection, ...requested],
      ctx,
      seen,
    );
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
  if (ctx.analysisComplete) {
    if (seen.has(exprId)) {
      return [];
    }
    const key = `${exprId}:${JSON.stringify(requested)}`;
    const cached = ctx.projectedPlacesCache.get(key);
    if (cached) {
      return cached;
    }
    if (ctx.projectedPlacesInProgress.has(key)) {
      return [];
    }
    ctx.projectedPlacesInProgress.add(key);
    try {
      const places = computePlacesAtProjection(
        exprId,
        requested,
        ctx,
        new Set(),
      );
      ctx.projectedPlacesCache.set(key, places);
      return places;
    } finally {
      ctx.projectedPlacesInProgress.delete(key);
    }
  }
  return computePlacesAtProjection(exprId, requested, ctx, seen);
}

function computePlacesAtProjection(
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

const localAggregateStoragePlacesAtProjection = (
  exprId: HirExprId,
  requested: readonly PlaceProjection[],
  ctx: BodyContext,
): readonly BorrowPlace[] | undefined => {
  const expression = ctx.hir.expressions.get(exprId);
  const explicitBorrowSource =
    expression?.exprKind === "call"
      ? ctx.hir.expressions.get(expression.args.at(-1)?.expr ?? -1)
      : undefined;
  const symbol =
    expression?.exprKind === "identifier"
      ? expression.symbol
      : explicitBorrowSource?.exprKind === "identifier" &&
          baseSymbolOf(exprId, ctx) === explicitBorrowSource.symbol
        ? explicitBorrowSource.symbol
        : undefined;
  if (typeof symbol !== "number") {
    return undefined;
  }
  const ownPlace = ctx.places.get(symbol);
  const initializer = ctx.bindingInitializers.get(symbol);
  if (
    ownPlace?.root !== symbol ||
    ownPlace.projections.length > 0 ||
    !(
      isAggregateExpression(exprId, ctx) ||
      (typeof initializer === "number" &&
        isAggregateExpression(initializer, ctx))
    )
  ) {
    return undefined;
  }
  const event = ctx.events.get(exprId);
  const aliases = event ? reachingAliasDefinitions(symbol, event, ctx) : [];
  const crossesReturnedReference = aliases.some((alias) => {
    if (alias.conservativeReturnedAggregate === true) {
      return requested.length > 0;
    }
    if (!alias.resultProjections) {
      return true;
    }
    return (
      requested.length > alias.resultProjections.length &&
      translateProjectionPath({
        result: alias.resultProjections,
        source: [],
        requested,
      }) !== undefined &&
      requested
        .slice(alias.resultProjections.length)
        .some((projection) => projection.kind === "dereference")
    );
  });
  return crossesReturnedReference
    ? undefined
    : [appendAccessProjections(ownPlace, requested)];
};

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
      ? (info.contract?.parameters[index]?.returnedSharedOrigins
          ?.filter(
            (origin) =>
              typeof actual === "number" || origin.defaultNoBorrow !== true,
          )
          .map((origin) =>
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
    const info = targetInfo(expr, ctx);
    return (
      info.contract?.parameters.some(
        (parameter) =>
          (parameter.returnedAggregate === true &&
            parameter.returnedOrigins?.some(
              (origin) => origin.result.length === 0,
            ) === true) ||
          (parameter.returned &&
            (!parameter.returnedOrigins ||
              parameter.returnedOrigins.length === 0)),
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
  callableResult?: boolean;
  externalResult?: boolean;
  capture?: boolean;
  checkedView?: true;
  contractSource?: SourceSpan;
};

const traitCoercionOrigins = ({
  value,
  targetType,
  ctx,
}: {
  value: HirExprId;
  targetType: TypeId | undefined;
  ctx: BodyContext;
}): readonly AggregateOrigin[] => {
  const projections = traitRegionProjectionsForCoercion({
    sourceType: typeOfExpr(value, ctx),
    targetType,
    hir: ctx.hir,
    typing: ctx.typing,
    symbolTable: ctx.symbolTable,
    moduleId: ctx.moduleId,
    imports: ctx.imports,
    dependencies: ctx.dependencies,
  });
  if (projections.length === 0) {
    return [];
  }
  return uniqueAggregateOrigins(
    placesOfExpression(value, ctx).flatMap((place) =>
      projections.map(({ source, result }) => ({
        place: source.reduce(appendProjection, place),
        resultProjections: [result],
        provenance: "allocation-alias" as const,
        access: "shared" as const,
        checkedView: true as const,
      })),
    ),
  );
};

const localizeExternalResultPlace = (
  place: BorrowPlace,
  binding: SymbolId,
): BorrowPlace => ({
  root: binding,
  projections: place.projections,
});

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
        placeOverlaps(alias.place, place, ctx, event) &&
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
        placeOverlaps(capturedPlace, place, ctx, event) &&
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
                placeOverlaps(actualPlace, place, ctx, ctx.events.get(expr.id)),
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
      ? projected.filter(
          (origin) =>
            origin.capture === true ||
            origin.checkedView === true ||
            origin.resultProjections.some(
              (projection) => projection.kind === "region",
            ),
        )
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
          if (
            origin.result.length === 0 &&
            !capture &&
            parameter.returnedAggregate !== true
          ) {
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
              callableResult: true,
              capture,
              contractSource: info.contractSources[0],
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
          callableResult: true,
          capture: expressionOriginIsCapture(
            actual,
            place,
            ctx,
            transfer.sourcePath ?? [],
          ),
          contractSource: info.contractSources[0],
        })),
      );
    });
    const external = externalReturnedOriginsForCall(info).flatMap((origin) => {
      if (origin.fresh) {
        return [];
      }
      const root = info.target?.symbol ?? info.targets[0]?.symbol;
      if (typeof root !== "number") {
        return [];
      }
      return [
        {
          place: applyBorrowEndpoint(
            { root, projections: [] },
            origin.endpointAccess,
          ),
          resultProjections: origin.result,
          provenance: "allocation-alias" as const,
          access: "shared" as const,
          callableResult: true,
          externalResult: true,
          contractSource: info.contractSources[0],
        },
      ];
    });
    return uniqueAggregateOrigins([
      ...(returned ?? []),
      ...(transferred ?? []),
      ...external,
    ]);
  }
  if (expr?.exprKind === "identifier") {
    const event = ctx.events.get(expr.id);
    const reaching = event
      ? reachingAliasDefinitions(expr.symbol, event, ctx)
      : [];
    const contained = reaching
      .filter((alias) => alias.plainIdentity !== true)
      .map((alias) => ({
        place: alias.place,
        resultProjections: alias.resultProjections ?? [],
        provenance: alias.provenance,
        access: alias.access,
        callableResult: alias.callableResult,
        externalResult: alias.externalResult,
        capture: alias.capture,
        contractSource: alias.contractSource,
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
        const resultType = typeOfExpr(expr.id, ctx);
        const traitCoercions =
          typeof resultType === "number"
            ? projectedTypes(resultType, [projection], ctx.typing).flatMap(
                (targetType) =>
                  traitCoercionOrigins({
                    value,
                    targetType,
                    ctx,
                  }).map((origin) => ({
                    ...origin,
                    resultProjections: [
                      projection,
                      ...origin.resultProjections,
                    ],
                  })),
              )
            : [];
        const alreadyBorrowed = expressionCarriesBorrowedProvenance(value, ctx);
        const nestedOrigins = aggregateOriginsOfExpression(
          value,
          ctx,
          new Set(seen),
        );
        const hasPreciseNestedOrigins = nestedOrigins.some(
          (origin) => origin.resultProjections.length > 0,
        );
        const direct =
          traitCoercions.length === 0 &&
          (!hasPreciseNestedOrigins ||
            baseSymbolOf(value, ctx) !== undefined) &&
          isReferenceLike(typeOfExpr(value, ctx), ctx)
            ? placesOfExpression(value, ctx).map((place) => ({
                place:
                  explicitBorrow &&
                  !alreadyBorrowed &&
                  borrowedEndpointIsDereferenced(
                    explicitBorrow.inner,
                    ctx.typing,
                  )
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
        const nested = nestedOrigins.map((origin) => ({
          ...origin,
          resultProjections: [projection, ...origin.resultProjections],
        }));
        return [...direct, ...traitCoercions, ...nested];
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
      const resultType = typeOfExpr(expr.id, ctx);
      const traitCoercions =
        typeof resultType === "number"
          ? projectedTypes(resultType, [projection], ctx.typing).flatMap(
              (targetType) =>
                traitCoercionOrigins({
                  value: entry.value,
                  targetType,
                  ctx,
                }).map((origin) => ({
                  ...origin,
                  resultProjections: [projection, ...origin.resultProjections],
                })),
            )
          : [];
      const alreadyBorrowed = expressionCarriesBorrowedProvenance(
        entry.value,
        ctx,
      );
      const nestedOrigins = aggregateOriginsOfExpression(
        entry.value,
        ctx,
        new Set(seen),
      );
      const hasPreciseNestedOrigins = nestedOrigins.some(
        (origin) => origin.resultProjections.length > 0,
      );
      const direct =
        traitCoercions.length === 0 &&
        (!hasPreciseNestedOrigins ||
          baseSymbolOf(entry.value, ctx) !== undefined) &&
        isReferenceLike(typeOfExpr(entry.value, ctx), ctx)
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
      const nested = nestedOrigins.map((origin) => ({
        ...origin,
        resultProjections: [projection, ...origin.resultProjections],
      }));
      return [...direct, ...traitCoercions, ...nested];
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
    const contract = targetInfo(expr, ctx).contract;
    return (
      contract?.parameters.some(
        (parameter) =>
          parameter.returnedAggregate === true ||
          parameter.returnedOrigins?.some((origin) => origin.result.length > 0),
      ) === true ||
      externalReturnedOriginsForCall(targetInfo(expr, ctx)).some(
        (origin) => origin.fresh === true || origin.result.length > 0,
      )
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
    callableResult: origin.callableResult,
    externalResult: origin.externalResult,
    capture: origin.capture,
    contractSource: origin.contractSource,
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
      const bindingMutable = pattern.bindingKind === "mutable-ref" || mutable;
      const localizedPlace =
        origin.externalResult === true
          ? localizeExternalResultPlace(origin.place, pattern.symbol)
          : origin.place;
      const alias: AliasDefinition = {
        symbol: pattern.symbol,
        place: normalizeMutableAliasPlace({
          place: localizedPlace,
          sourceType: bindingType,
          mutable: bindingMutable && bindingContainsBorrow,
          ctx,
        }),
        access: bindingMutable ? "mutable" : (origin.access ?? "shared"),
        provenance: bindingContainsBorrow
          ? bindingMutable
            ? "storage-borrow"
            : origin.provenance
          : "allocation-alias",
        span: pattern.span ?? span,
        event,
        uses: [],
        ...(origin.callableResult === true ? { callableResult: true } : {}),
        ...(origin.externalResult === true ? { externalResult: true } : {}),
        ...(origin.capture === true ? { capture: true } : {}),
        ...(origin.contractSource
          ? { contractSource: origin.contractSource }
          : {}),
        ...(origin.resultProjections.length > 0
          ? { resultProjections: origin.resultProjections }
          : {}),
      };
      if (ctx.aliases.has(pattern.symbol)) {
        addAssignmentAlias(alias, ctx);
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
  const materializesPlainValue =
    !mutable &&
    pattern.bindingKind !== "mutable-ref" &&
    expressionMaterializesPlainProjection(value, ctx);
  const bindsMutableReference =
    pattern.bindingKind === "mutable-ref" &&
    baseSymbolOf(value, ctx) !== undefined;
  const directPlaces = materializesPlainValue
    ? []
    : bindsMutableReference
      ? placesOfExpression(value, ctx)
      : placesStoredByExpression(value, ctx);
  const contractSource = borrowContractSourceOfExpression(value, ctx);
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
        contractSource,
      }),
    );
  } else if (materializesPlainValue) {
    bindPatternPlaces({
      pattern,
      mutable,
      span,
      event,
      ctx,
    });
  }
  aggregateOriginsOfExpression(value, ctx).forEach((origin) => {
    const preservesCheckedView =
      origin.checkedView === true ||
      origin.resultProjections.some(
        (projection) => projection.kind === "region",
      );
    const alias: AliasDefinition = {
      symbol: pattern.symbol,
      place: origin.place,
      access:
        !materializesPlainValue &&
        directPlaces.length > 0 &&
        (mutable || pattern.bindingKind === "mutable-ref")
          ? "mutable"
          : (origin.access ?? "shared"),
      provenance:
        !materializesPlainValue &&
        directPlaces.length > 0 &&
        (mutable || pattern.bindingKind === "mutable-ref")
          ? "storage-borrow"
          : origin.provenance,
      span: pattern.span ?? span,
      event,
      uses: [],
      ...(origin.callableResult === true ? { callableResult: true } : {}),
      ...(origin.externalResult === true ? { externalResult: true } : {}),
      ...(origin.capture === true ? { capture: true } : {}),
      ...(materializesPlainValue &&
      origin.capture !== true &&
      !preservesCheckedView
        ? { plainIdentity: true as const }
        : {}),
      ...(origin.contractSource
        ? { contractSource: origin.contractSource }
        : {}),
      ...(origin.resultProjections.length > 0
        ? { resultProjections: origin.resultProjections }
        : {}),
      ...(conservativeReturnedAggregate
        ? { conservativeReturnedAggregate: true }
        : {}),
    };
    if (ctx.aliases.has(pattern.symbol)) {
      addAssignmentAlias(alias, ctx);
    } else {
      ctx.aliases.set(pattern.symbol, alias);
    }
  });
};

const bindTraitCoercionPatternOrigins = ({
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
  if (pattern.kind === "type" && pattern.binding) {
    bindTraitCoercionPatternOrigins({
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
  traitCoercionOrigins({
    value,
    targetType: ctx.typing.valueTypes.get(pattern.symbol),
    ctx,
  }).forEach((origin) =>
    bindPatternAggregateOrigin({
      pattern,
      origin,
      mutable,
      span,
      event,
      ctx,
    }),
  );
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
    if (!ctx.initialBindingInitializers.has(pattern.symbol)) {
      ctx.initialBindingInitializers.set(pattern.symbol, value);
    }
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
  patternSymbols(pattern).forEach((symbol) => {
    if (!ctx.initialBindingInitializers.has(symbol)) {
      ctx.initialBindingInitializers.set(symbol, value);
    }
    ctx.bindingInitializers.set(symbol, value);
  });
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
  externalResult = false,
  contractSource,
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
  externalResult?: boolean;
  contractSource?: SourceSpan;
}): void => {
  const projected =
    source && projection ? appendProjection(source, projection) : source;
  switch (pattern.kind) {
    case "identifier": {
      const localizedPlace =
        projected && externalResult
          ? localizeExternalResultPlace(projected, pattern.symbol)
          : projected;
      const bindingMutable =
        pattern.bindingKind === "mutable-ref" || (mutable && !localizedPlace);
      const bindingPlace =
        localizedPlace &&
        normalizeMutableAliasPlace({
          place: localizedPlace,
          sourceType: ctx.typing.valueTypes.get(pattern.symbol),
          mutable: bindingMutable,
          ctx,
        });
      if (bindingPlace) {
        ctx.places.set(pattern.symbol, bindingPlace);
        const alias: AliasDefinition = {
          symbol: pattern.symbol,
          place: bindingPlace,
          access: bindingMutable ? "mutable" : "shared",
          provenance: bindingMutable ? "storage-borrow" : provenance,
          span: pattern.span ?? span,
          event,
          uses: [],
          ...(conservativeReturnedAggregate
            ? { conservativeReturnedAggregate: true }
            : {}),
          ...(externalResult ? { externalResult: true } : {}),
          ...(contractSource ? { contractSource } : {}),
        };
        if (ctx.aliases.has(pattern.symbol)) {
          addAssignmentAlias(alias, ctx);
        } else {
          ctx.aliases.set(pattern.symbol, alias);
        }
      } else {
        const ownPlace = {
          root: pattern.symbol,
          projections: [],
        };
        ctx.places.set(pattern.symbol, ownPlace);
        if (externalResult) {
          const alias: AliasDefinition = {
            symbol: pattern.symbol,
            place: ownPlace,
            access: bindingMutable ? "mutable" : "shared",
            provenance: "allocation-alias",
            span: pattern.span ?? span,
            event,
            uses: [],
            externalResult: true,
          };
          if (ctx.aliases.has(pattern.symbol)) {
            addAssignmentAlias(alias, ctx);
          } else {
            ctx.aliases.set(pattern.symbol, alias);
          }
        }
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
          externalResult,
          contractSource,
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
          externalResult,
          contractSource,
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
          externalResult,
          contractSource,
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
          externalResult,
          contractSource,
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
    if (
      ctx.assignmentAliasesBySymbol
        .get(alias.symbol)
        ?.some(aliasAlreadyRecorded)
    ) {
      return;
    }
    addAssignmentAlias(alias, ctx);
    return;
  }
  const current = ctx.aliases.get(alias.symbol);
  if (!current) {
    ctx.aliases.set(alias.symbol, alias);
    return;
  }
  if (
    aliasAlreadyRecorded(current) ||
    ctx.assignmentAliasesBySymbol.get(alias.symbol)?.some(aliasAlreadyRecorded)
  ) {
    return;
  }
  addAssignmentAlias(alias, ctx);
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

const storedIdentityPlacesOfExpression = (
  exprId: HirExprId,
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  const accessPath = (
    current: HirExprId,
  ):
    | {
        root: Extract<HirExpression, { exprKind: "identifier" }>;
        path: PlaceProjection[];
      }
    | undefined => {
    const expression = ctx.hir.expressions.get(current);
    if (expression?.exprKind === "identifier") {
      return { root: expression, path: [] };
    }
    if (expression?.exprKind !== "field-access") {
      return undefined;
    }
    const target = accessPath(expression.target);
    if (!target) {
      return undefined;
    }
    const projection = Number.isInteger(Number(expression.field))
      ? ({ kind: "tuple", index: Number(expression.field) } as const)
      : ({ kind: "field", name: expression.field } as const);
    return { root: target.root, path: [...target.path, projection] };
  };
  const access = accessPath(exprId);
  if (!access || access.path.length === 0) {
    return [];
  }
  const event = ctx.events.get(access.root.id);
  const aliases = event
    ? reachingAliasDefinitions(access.root.symbol, event, ctx)
    : [];
  return uniquePlaces(
    aliases.flatMap((alias) => {
      if (alias.resultProjections?.length !== access.path.length) {
        return [];
      }
      const translated = translateProjectionPath({
        result: alias.resultProjections,
        source: alias.place.projections,
        requested: access.path,
      });
      return translated
        ? [{ root: alias.place.root, projections: translated }]
        : [];
    }),
  );
};

const placesForBorrowFormation = (
  exprId: HirExprId,
  path: readonly PlaceProjection[],
  ctx: BodyContext,
): readonly BorrowPlace[] => {
  if (path.length > 0) {
    return placesAtProjection(exprId, path, ctx, new Set());
  }
  if (
    expressionReturnsExternalResult(exprId, ctx) ||
    expressionReturnsFromArguments(exprId, ctx)
  ) {
    return placesOfExpression(exprId, ctx);
  }
  const storedIdentity = storedIdentityPlacesOfExpression(exprId, ctx);
  return uniquePlaces([
    ...storedIdentity,
    ...directPlacesOfExpression(exprId, ctx),
  ]);
};

const expressionReturnsFromArguments = (
  exprId: HirExprId,
  ctx: BodyContext,
): boolean => {
  const expression = ctx.hir.expressions.get(exprId);
  if (
    expression?.exprKind !== "call" &&
    expression?.exprKind !== "method-call"
  ) {
    return false;
  }
  return (
    targetInfo(expression, ctx).contract?.parameters.some(
      (parameter) => parameter.returned,
    ) === true
  );
};

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
      const externalResult = expressionReturnsExternalResult(
        leaf,
        ctx,
        sourcePath,
      );
      sources.forEach((source) => {
        const localizedSource = externalResult
          ? localizeExternalResultPlace(source, symbol)
          : source;
        if (
          !externalResult &&
          !sourceOutlivesBinding(source.root, symbol, ctx)
        ) {
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
              ? applyBorrowEndpoint(localizedSource, "dereferenced")
              : localizedSource,
            access: "shared",
            provenance: "storage-borrow",
            span,
            event,
            uses: [],
            ...(externalResult ? { externalResult: true } : {}),
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
          const externalResult = expressionReturnsExternalResult(
            statement.initializer,
            ctx,
          );
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
          const materializesPlainValue =
            !createsMutableBinding &&
            expressionMaterializesPlainProjection(statement.initializer, ctx);
          const initializerHasAddressableRoot =
            baseSymbolOf(statement.initializer, ctx) !== undefined;
          const sources =
            returnsDetachedSharedValue ||
            materializesBorrowedPrimitive ||
            materializesPlainValue
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
                normalizeMutableAliasPlace({
                  place: source,
                  sourceType: initializerType,
                  mutable: dereferenceProjectedSource,
                  ctx,
                }),
              mutable: !returnsDetachedSharedValue && createsMutableBinding,
              provenance,
              span: statement.span,
              event,
              ctx,
              conservativeReturnedAggregate: hasConservativeReturnedAggregate(
                statement.initializer,
                ctx,
              ),
              externalResult,
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
          bindTraitCoercionPatternOrigins({
            pattern: statement.pattern,
            value: statement.initializer,
            mutable: createsMutableBinding,
            span: statement.span,
            event,
            ctx,
          });
          const initializer = ctx.hir.expressions.get(statement.initializer);
          if (
            !returnsDetachedSharedValue &&
            !materializesBorrowedPrimitive &&
            !(
              createsMutableBinding &&
              initializerHasAddressableRoot &&
              !materializesPlainValue
            ) &&
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
                addAssignmentAlias(
                  {
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
                  },
                  ctx,
                );
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
          if (ctx.borrowedParameterSymbols.has(target.symbol)) {
            break;
          }
          const assigned = ctx.hir.expressions.get(expr.value);
          const materializesBorrowedPrimitive =
            expressionMaterializesBorrowedPrimitive(
              expr.value,
              [ctx.typing.valueTypes.get(target.symbol)],
              ctx,
            );
          const traitOrigins = traitCoercionOrigins({
            value: expr.value,
            targetType: ctx.typing.valueTypes.get(target.symbol),
            ctx,
          });
          const aggregateAssignment =
            !materializesBorrowedPrimitive &&
            (assigned?.exprKind === "tuple" ||
              assigned?.exprKind === "object-literal" ||
              isAggregateExpression(expr.value, ctx) ||
              aggregateContentsPlaces(expr.value, ctx).length > 0 ||
              traitOrigins.length > 0);
          if (aggregateAssignment) {
            ctx.bindingInitializers.set(target.symbol, expr.value);
          } else {
            ctx.bindingInitializers.delete(target.symbol);
          }
          ctx.unknownCallableBindings.add(target.symbol);
          const event = eventFor(expr.span, scan, ctx);
          addReassignment(
            {
              symbol: target.symbol,
              event,
              ...(aggregateAssignment ? { initializer: expr.value } : {}),
            },
            ctx,
          );
          const sourceActor = baseSymbolOf(expr.value, ctx);
          const preservesMutableCapability =
            hasMutableCapabilityAt(target.symbol, event, ctx) &&
            typeof sourceActor === "number" &&
            hasMutableCapabilityAt(sourceActor, event, ctx);
          const assignedType = typeOfExpr(expr.value, ctx);
          const preservesMutableReference =
            preservesMutableCapability &&
            typeof assignedType === "number" &&
            typeIsAllocationBacked(assignedType, ctx.typing);
          const sources = materializesBorrowedPrimitive
            ? []
            : preservesMutableReference
              ? placesOfExpression(expr.value, ctx)
              : placesStoredByExpression(expr.value, ctx);
          const assignedProvenance = expressionCarriesBorrowedProvenance(
            expr.value,
            ctx,
          )
            ? "storage-borrow"
            : "allocation-alias";
          const externalResult = expressionReturnsExternalResult(
            expr.value,
            ctx,
          );
          if (sources.length > 0) {
            sources.forEach((source) => {
              const localizedSource = externalResult
                ? localizeExternalResultPlace(source, target.symbol)
                : source;
              addAssignmentAlias(
                {
                  symbol: target.symbol,
                  place: normalizeMutableAliasPlace({
                    place: localizedSource,
                    sourceType: assignedType,
                    mutable: preservesMutableCapability,
                    ctx,
                  }),
                  access: preservesMutableCapability ? "mutable" : "shared",
                  provenance: preservesMutableCapability
                    ? "storage-borrow"
                    : assignedProvenance,
                  span: expr.span,
                  event,
                  uses: [],
                  ...(externalResult ? { externalResult: true } : {}),
                  ...(hasConservativeReturnedAggregate(expr.value, ctx)
                    ? { conservativeReturnedAggregate: true }
                    : {}),
                },
                ctx,
              );
            });
          }
          const aggregateOrigins = aggregateAssignment
            ? [
                ...aggregateOriginsOfExpression(expr.value, ctx),
                ...traitOrigins,
              ]
            : [];
          if (aggregateAssignment) {
            aggregateOrigins.forEach((origin) =>
              addAssignmentAlias(
                {
                  symbol: target.symbol,
                  place:
                    origin.externalResult === true
                      ? localizeExternalResultPlace(origin.place, target.symbol)
                      : origin.place,
                  access: "shared",
                  provenance: origin.provenance,
                  span: expr.span,
                  event,
                  uses: [],
                  ...(origin.callableResult === true
                    ? { callableResult: true }
                    : {}),
                  ...(origin.externalResult === true
                    ? { externalResult: true }
                    : {}),
                  ...(origin.resultProjections.length > 0
                    ? { resultProjections: origin.resultProjections }
                    : {}),
                  ...(hasConservativeReturnedAggregate(expr.value, ctx)
                    ? { conservativeReturnedAggregate: true }
                    : {}),
                },
                ctx,
              ),
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
  if (expr.exprKind === "assign" && typeof expr.target === "number") {
    const target = ctx.hir.expressions.get(expr.target);
    if (target?.exprKind === "field-access") {
      const targetPlaces =
        valueFieldStoragePlaces(expr.target, ctx) ??
        placesOfExpression(expr.target, ctx);
      targetPlaces.forEach((place) =>
        recordFreshnessInvalidation(place, event, ctx),
      );
    }
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    recordDirectCallFreshnessInvalidations(expr, event, ctx);
  }
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

const allAliases = (ctx: BodyContext): readonly AliasDefinition[] => {
  if (ctx.completedAliases) {
    return ctx.completedAliases;
  }
  const aliases = [...ctx.aliases.values(), ...ctx.assignmentAliases];
  if (ctx.analysisComplete) {
    ctx.completedAliases = aliases;
  }
  return aliases;
};

const aliasesForSymbol = (
  symbol: SymbolId,
  ctx: BodyContext,
): readonly AliasDefinition[] => {
  const primary = ctx.aliases.get(symbol);
  return [
    ...(primary ? [primary] : []),
    ...(ctx.assignmentAliasesBySymbol.get(symbol) ?? []),
  ];
};

const definitelyReaches = (definition: Event, use: Event): boolean =>
  Array.from(definition.path).every(
    ([branch, alternative]) => use.path.get(branch) === alternative,
  ) && Array.from(definition.loops).every((loop) => use.loops.has(loop));

const freshAllocationOriginOfPlace = (
  place: BorrowPlace,
  ctx: BodyContext,
  event?: Event,
): HirExprId | undefined => {
  const dereference = place.projections.findIndex(
    (projection) => projection.kind === "dereference",
  );
  const definitionCanReachAccess = (
    definition: Event,
    access: Event | undefined,
  ): boolean => {
    if (!access) {
      return true;
    }
    return (
      pathsCompatible(definition.path, access.path) &&
      ((definition.position <= access.position &&
        !definitionEndsBefore(definition, access, ctx)) ||
        definitionCanReachOnLoopBackedge(definition, access, ctx))
    );
  };
  const stableInitializerOf = (
    symbol: SymbolId,
    access: Event | undefined,
  ): HirExprId | undefined => {
    const initial = ctx.initialBindingInitializers.get(symbol);
    if (!access) {
      return ctx.reassignments.some(
        (reassignment) => reassignment.symbol === symbol,
      )
        ? undefined
        : (initial ?? ctx.bindingInitializers.get(symbol));
    }
    const initialEvent =
      typeof initial === "number" ? ctx.events.get(initial) : undefined;
    const candidates = [
      ...(typeof initial === "number" && initialEvent
        ? [{ initializer: initial, event: initialEvent }]
        : []),
      ...ctx.reassignments
        .filter((reassignment) => reassignment.symbol === symbol)
        .map((reassignment) => ({
          initializer: reassignment.initializer,
          event: reassignment.event,
        })),
    ].filter((candidate) => definitionCanReachAccess(candidate.event, access));
    const reaching = candidates.filter(
      (candidate) =>
        !candidates.some(
          (replacement) =>
            replacement !== candidate &&
            replacement.event.position > candidate.event.position &&
            replacement.event.position <= access.position &&
            definitelyReaches(replacement.event, access),
        ),
    );
    return reaching.length === 1 ? reaching[0]!.initializer : undefined;
  };
  const storageWasInvalidated = (
    symbol: SymbolId,
    path: readonly PlaceProjection[],
    access: Event | undefined,
  ): boolean =>
    ctx.freshnessInvalidations.some(
      (invalidation) =>
        invalidation.place.root === symbol &&
        projectionPathCovers(invalidation.place.projections, path) &&
        definitionCanReachAccess(invalidation.event, access),
    );
  const initializer = stableInitializerOf(place.root, event);
  if (dereference < 0 || typeof initializer !== "number") {
    return undefined;
  }
  const storagePath = place.projections.slice(0, dereference);
  if (
    storagePath.length > 0 &&
    storageWasInvalidated(place.root, storagePath, event)
  ) {
    return undefined;
  }
  const providerAtPath = (
    exprId: HirExprId,
    path: readonly PlaceProjection[],
    seen = new Set<HirExprId>(),
  ): HirExprId | undefined => {
    if (seen.has(exprId)) {
      return undefined;
    }
    seen.add(exprId);
    const expression = ctx.hir.expressions.get(exprId);
    if (!expression) {
      return undefined;
    }
    if (path.length === 0) {
      const type = typeOfExpr(exprId, ctx);
      if (
        expression.exprKind === "object-literal" &&
        typeof type === "number" &&
        typeIsAllocationBacked(type, ctx.typing)
      ) {
        return exprId;
      }
      if (
        (expression.exprKind === "call" ||
          expression.exprKind === "method-call") &&
        (targetInfo(expression, ctx).contract?.freshResult === true ||
          externalReturnedOriginsForCall(targetInfo(expression, ctx)).some(
            (origin) => origin.fresh === true && origin.result.length === 0,
          ))
      ) {
        return exprId;
      }
    }
    if (expression.exprKind === "identifier") {
      const providerEvent = ctx.events.get(exprId);
      if (storageWasInvalidated(expression.symbol, path, providerEvent)) {
        return undefined;
      }
      const nestedInitializer = stableInitializerOf(
        expression.symbol,
        providerEvent,
      );
      return typeof nestedInitializer === "number"
        ? providerAtPath(nestedInitializer, path, seen)
        : undefined;
    }
    if (
      expression.exprKind === "block" &&
      typeof expression.value === "number"
    ) {
      return providerAtPath(expression.value, path, seen);
    }
    const [projection, ...remaining] = path;
    if (
      expression.exprKind === "object-literal" &&
      projection?.kind === "field"
    ) {
      const provider = objectLiteralProjectionProvider({
        expression,
        projection,
        ctx,
      });
      return provider
        ? providerAtPath(
            provider.value,
            provider.kind === "spread" ? path : remaining,
            seen,
          )
        : undefined;
    }
    if (expression.exprKind === "tuple" && projection?.kind === "tuple") {
      const element = expression.elements[projection.index];
      return typeof element === "number"
        ? providerAtPath(element, remaining, seen)
        : undefined;
    }
    return undefined;
  };
  return providerAtPath(initializer, storagePath);
};

const recordFreshnessInvalidation = (
  place: BorrowPlace,
  event: Event,
  ctx: BodyContext,
): void => {
  if (
    place.projections.some((projection) => projection.kind === "dereference") ||
    ctx.freshnessInvalidations.some(
      (candidate) =>
        candidate.event === event &&
        JSON.stringify(candidate.place) === JSON.stringify(place),
    )
  ) {
    return;
  }
  ctx.freshnessInvalidations.push({ place, event });
};

const placeOverlaps = (
  left: BorrowPlace,
  right: BorrowPlace,
  ctx: BodyContext,
  event?: Event,
): boolean => {
  if (left.root !== right.root) {
    return false;
  }
  const leftFreshOrigin = freshAllocationOriginOfPlace(left, ctx, event);
  const rightFreshOrigin = freshAllocationOriginOfPlace(right, ctx, event);
  if (
    typeof leftFreshOrigin === "number" &&
    typeof rightFreshOrigin === "number"
  ) {
    if (leftFreshOrigin !== rightFreshOrigin) {
      return false;
    }
    const leftDereference = left.projections.findIndex(
      (projection) => projection.kind === "dereference",
    );
    const rightDereference = right.projections.findIndex(
      (projection) => projection.kind === "dereference",
    );
    return projectionPathsOverlap(
      left.projections.slice(leftDereference + 1),
      right.projections.slice(rightDereference + 1),
    );
  }
  return projectionPathsOverlap(left.projections, right.projections);
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
    if (projection.kind === "region") {
      return `${name}.<region ${projection.name}>`;
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
  if (!loopCarried) {
    const candidates = [
      ...aliasesForSymbol(alias.symbol, ctx).map(
        (candidate) => candidate.event,
      ),
      ...(ctx.reassignmentsBySymbol.get(alias.symbol) ?? []).map(
        (candidate) => candidate.event,
      ),
    ];
    if (
      alias.event.position < latestDefinitelyReachingPosition(candidates, event)
    ) {
      return false;
    }
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
    ...aliasesForSymbol(alias.symbol, ctx).map((candidate) => ({
      symbol: candidate.symbol,
      event: candidate.event,
    })),
    ...(ctx.reassignmentsBySymbol.get(alias.symbol) ?? []),
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
  contractSource,
  ctx,
}: {
  attempted: BorrowPlace;
  access: "shared" | "mutable";
  existing: AliasDefinition;
  event: Event;
  contractSource?: SourceSpan;
  ctx: BodyContext;
}): void => {
  const existingPlace =
    existing.externalResult === true
      ? localizeExternalResultPlace(existing.place, existing.symbol)
      : existing.place;
  const attemptedPlace =
    existing.externalResult === true && attempted.root === existing.place.root
      ? localizeExternalResultPlace(attempted, existing.symbol)
      : attempted;
  const initializer = ctx.bindingInitializers.get(existing.symbol);
  const originContractSource =
    existing.contractSource ??
    (typeof initializer === "number"
      ? borrowContractSourceOfExpression(initializer, ctx)
      : undefined);
  const lastUse = existing.uses
    .filter((use) => pathsCompatible(use.path, event.path))
    .sort((left, right) => right.position - left.position)[0];
  const related = [
    diagnosticFromCode({
      code: "TY0048",
      params: {
        kind: "borrow-origin",
        place: placeName(existingPlace, ctx),
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
    ...((contractSource ?? originContractSource)
      ? [
          {
            code: "TY0048",
            message: "callable borrow contract declared here",
            severity: "note" as const,
            phase: "typing" as const,
            span: (contractSource ?? originContractSource)!,
          },
        ]
      : []),
  ];
  addDiagnostic(
    diagnosticFromCode({
      code: "TY0048",
      params: {
        kind: "borrow-conflict",
        access: access === "mutable" ? "mutably borrow" : "read",
        place: placeName(attemptedPlace, ctx),
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
  contractSource,
  externalResult,
  ctx,
}: {
  place: BorrowPlace;
  actor?: SymbolId;
  access: "shared" | "mutable";
  event: Event;
  contractSource?: SourceSpan;
  externalResult?: boolean;
  ctx: BodyContext;
}): void => {
  const actorHasExternalResult =
    externalResult === true ||
    (externalResult === undefined &&
      typeof actor === "number" &&
      aliasesForSymbol(actor, ctx).some(
        (alias) =>
          alias.symbol === actor &&
          alias.externalResult === true &&
          aliasActiveAt(alias, event, ctx),
      ));
  const candidates = actorHasExternalResult
    ? allAliases(ctx)
    : (ctx.completedAliasesByRoot.get(place.root) ?? []);
  candidates.forEach((alias) => {
    if (
      alias.symbol === actor ||
      (!actorHasExternalResult &&
        !placeOverlaps(alias.place, place, ctx, event))
    ) {
      return;
    }
    if (actorHasExternalResult && alias.externalResult !== true) {
      const cachedLocality = ctx.aliasRootLocality.get(alias.place.root);
      const aliasRootIsCallLocal =
        cachedLocality ??
        (() => {
          if (!ctx.symbolTable.hasSymbol(alias.place.root)) {
            ctx.aliasRootLocality.set(alias.place.root, false);
            return false;
          }
          const aliasRootRecord = ctx.symbolTable.getSymbol(alias.place.root);
          const local =
            !ctx.parameterSymbols.has(alias.place.root) &&
            ctx.symbolTable.getScope(aliasRootRecord.scope).kind !== "module";
          ctx.aliasRootLocality.set(alias.place.root, local);
          return local;
        })();
      if (aliasRootIsCallLocal) {
        return;
      }
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
    reportConflict({
      attempted: place,
      access,
      existing: alias,
      event,
      contractSource,
      ctx,
    });
  });
};

const checkExternalAccess = ({
  access,
  event,
  contractSource,
  ctx,
}: {
  access: "shared" | "mutable";
  event: Event;
  contractSource?: SourceSpan;
  ctx: BodyContext;
}): void => {
  allAliases(ctx).forEach((alias) => {
    const canOverlapExternalStorage =
      alias.externalResult === true ||
      alias.capture === true ||
      ctx.parameterSymbols.has(alias.place.root) ||
      (() => {
        if (!ctx.symbolTable.hasSymbol(alias.place.root)) {
          return true;
        }
        const root = ctx.symbolTable.getSymbol(alias.place.root);
        return ctx.symbolTable.getScope(root.scope).kind === "module";
      })() ||
      ctx.externalizedPlaces.some(
        (externalized) =>
          externalized.event.position <= event.position &&
          pathsCompatible(externalized.event.path, event.path) &&
          placeOverlaps(externalized.place, alias.place, ctx, event),
      );
    if (
      !canOverlapExternalStorage ||
      alias.provenance === "allocation-alias" ||
      !aliasActiveAt(alias, event, ctx) ||
      (alias.access === "shared" && access === "shared")
    ) {
      return;
    }
    reportConflict({
      attempted: alias.place,
      access,
      existing: alias,
      event,
      contractSource,
      ctx,
    });
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
): readonly { symbol: SymbolId; alias: AliasDefinition }[] => {
  const cached = ctx.analysisComplete
    ? ctx.escapedPlacesCache.get(exprId)
    : undefined;
  if (cached) {
    return cached;
  }
  const symbols = new Set<SymbolId>();
  const captured: { symbol: SymbolId; alias: AliasDefinition }[] = [];
  const projectedAliases: { symbol: SymbolId; alias: AliasDefinition }[] = [];
  const seenExpressions = new Set<HirExprId>();
  const seenProjectedExpressions = new Set<string>();
  const collectEscaped = (id: HirExprId): void => {
    escapedPlacesIn(id, ctx).forEach((entry) => {
      projectedAliases.push(entry);
    });
  };
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
    const key = `${id}:${JSON.stringify(requested)}`;
    if (seenProjectedExpressions.has(key)) {
      return;
    }
    seenProjectedExpressions.add(key);
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
            if (translated.length === 0) {
              collectEscaped(actual);
            } else {
              visitAtProjection(actual, translated);
            }
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
    if (seenExpressions.has(id)) {
      return;
    }
    seenExpressions.add(id);
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
              ...(origin.callableResult === true
                ? { callableResult: true }
                : {}),
              ...(origin.externalResult === true
                ? { externalResult: true }
                : {}),
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
          origins.forEach((origin) => {
            if (origin.source.length === 0) {
              collectEscaped(actual);
            } else {
              visitAtProjection(actual, origin.source);
            }
          });
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
  const escaped = [
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
  if (ctx.analysisComplete) {
    ctx.escapedPlacesCache.set(exprId, escaped);
  }
  return escaped;
};

const recordExternalizedExpression = ({
  exprId,
  projectionPaths,
  event,
  ctx,
}: {
  exprId: HirExprId;
  projectionPaths: readonly (readonly PlaceProjection[])[];
  event: Event;
  ctx: BodyContext;
}): void => {
  const direct = projectionPaths.flatMap((path) =>
    placesAtProjection(exprId, path, ctx, new Set()),
  );
  const aliased = escapedPlacesIn(exprId, ctx).flatMap(({ alias }) => {
    if (alias.conservativeReturnedAggregate) {
      return [alias.place];
    }
    return projectionPaths.flatMap((path) => {
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
  });
  uniquePlaces([...direct, ...aliased]).forEach((place) => {
    const rootType = ctx.typing.valueTypes.get(place.root);
    const placeTypes =
      typeof rootType === "number"
        ? projectedTypes(rootType, place.projections, ctx.typing)
        : [];
    const containedReferencePlaces = placeTypes.flatMap((type) =>
      materializedObjectReferencePaths(type, ctx.typing).map((path) =>
        path.reduce(appendProjection, place),
      ),
    );
    const variants = uniquePlaces([place, ...containedReferencePlaces]).flatMap(
      (candidate) => {
        if (candidate.projections.at(-1)?.kind === "dereference") {
          return [candidate];
        }
        const candidateTypes =
          typeof rootType === "number"
            ? projectedTypes(rootType, candidate.projections, ctx.typing)
            : [];
        return candidateTypes.some((type) =>
          typeIsAllocationBacked(type, ctx.typing),
        )
          ? [applyBorrowEndpoint(candidate, "dereferenced")]
          : [];
      },
    );
    uniquePlaces(variants).forEach((variant) => {
      const alreadyExternalized = ctx.externalizedPlaces.some(
        (candidate) =>
          candidate.event === event &&
          placeOverlaps(candidate.place, variant, ctx, event),
      );
      if (!alreadyExternalized) {
        ctx.externalizedPlaces.push({ place: variant, event });
      }
    });
  });
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
  const escapeEvent = ctx.events.get(exprId);
  if (escapeEvent) {
    recordExternalizedExpression({
      exprId,
      projectionPaths,
      event: escapeEvent,
      ctx,
    });
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
    if (
      alias.access === "mutable" &&
      (alias.provenance === "storage-borrow" || alias.capture === true)
    ) {
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

const recordDirectCallFreshnessInvalidations = (
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  event: Event,
  ctx: BodyContext,
): void => {
  if (expr.exprKind === "call" && intrinsicNameForCall(expr, ctx) === "~") {
    return;
  }
  const info = targetInfo(expr, ctx);
  const storagePlaces = (
    actual: HirExprId,
    path: readonly PlaceProjection[],
  ): readonly BorrowPlace[] =>
    localAggregateStoragePlacesAtProjection(actual, path, ctx) ??
    placesAtProjection(actual, path, ctx, new Set());
  const writtenSlots =
    info.contract?.parameters.flatMap((parameter, index) => {
      const actual = info.arguments[index];
      return typeof actual === "number"
        ? (parameter.writePaths ?? []).flatMap((path) =>
            storagePlaces(actual, path),
          )
        : [];
    }) ?? [];
  const transferredSlots =
    info.contract?.transfers?.flatMap((transfer) => {
      const actual = info.arguments[transfer.destinationParameter];
      return typeof actual === "number"
        ? storagePlaces(actual, transfer.destinationPath ?? [])
        : [];
    }) ?? [];
  uniquePlaces([...writtenSlots, ...transferredSlots]).forEach((place) =>
    recordFreshnessInvalidation(place, event, ctx),
  );
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
  const defaultProjectionCanBeExternal = (
    index: number,
    requested: readonly PlaceProjection[],
    seen = new Set<number>(),
  ): boolean => {
    if (typeof actuals[index] === "number" || seen.has(index)) {
      return false;
    }
    seen.add(index);
    const parameter = info.contract?.parameters[index];
    if (
      parameter?.defaultExternalOrigins?.some(
        (origin) =>
          origin.fresh !== true &&
          translateProjectionPath({
            result: origin.result,
            source: [],
            requested,
          }) !== undefined,
      )
    ) {
      return true;
    }
    return (
      parameter?.defaultOrigins?.some((origin) => {
        const translated = translateProjectionPath({
          result: origin.result,
          source: origin.source,
          requested,
        });
        return (
          translated !== undefined &&
          defaultProjectionCanBeExternal(
            origin.parameter,
            translated,
            new Set(seen),
          )
        );
      }) ?? false
    );
  };
  const resolveDefaultActualOrigins = (
    index: number,
    requested: readonly PlaceProjection[],
    seen = new Set<number>(),
  ): readonly {
    actual: HirExprId;
    path: readonly PlaceProjection[];
  }[] => {
    const actual = actuals[index];
    if (typeof actual === "number") {
      return [{ actual, path: requested }];
    }
    if (seen.has(index)) {
      return [];
    }
    seen.add(index);
    return (
      info.contract?.parameters[index]?.defaultOrigins?.flatMap((origin) => {
        const translated = translateCallOriginPath({
          info,
          parameterIndex: origin.parameter,
          origin,
          requested,
          ctx,
        });
        return translated === undefined
          ? []
          : resolveDefaultActualOrigins(
              origin.parameter,
              translated,
              new Set(seen),
            );
      }) ?? []
    );
  };
  const externalCallAccess = info.contract?.externalWrite
    ? ("mutable" as const)
    : info.contract?.externalRead
      ? ("shared" as const)
      : undefined;
  const externalDefaultBodyAccess = info.contract?.parameters.some(
    (parameter, index) =>
      typeof actuals[index] !== "number" &&
      parameter.writePaths?.some((path) =>
        defaultProjectionCanBeExternal(index, path),
      ),
  )
    ? ("mutable" as const)
    : info.contract?.parameters.some(
          (parameter, index) =>
            typeof actuals[index] !== "number" &&
            parameter.readPaths?.some((path) =>
              defaultProjectionCanBeExternal(index, path),
            ),
        )
      ? ("shared" as const)
      : undefined;
  const overlappingExternalAccess =
    externalCallAccess === "mutable" || externalDefaultBodyAccess === "mutable"
      ? ("mutable" as const)
      : (externalCallAccess ?? externalDefaultBodyAccess);
  info.contract?.parameters.forEach((parameter, index) => {
    const actual = actuals[index];
    if (parameter.retained !== true) {
      return;
    }
    const retainedPaths =
      parameter.retainedPaths && parameter.retainedPaths.length > 0
        ? parameter.retainedPaths
        : [[]];
    const retainedActuals =
      typeof actual === "number"
        ? retainedPaths.map((path) => ({ actual, path }))
        : retainedPaths.flatMap((path) =>
            resolveDefaultActualOrigins(index, path),
          );
    retainedActuals.forEach((retained) => {
      recordExternalizedExpression({
        exprId: retained.actual,
        projectionPaths: [retained.path],
        event,
        ctx,
      });
    });
  });
  if (overlappingExternalAccess) {
    checkExternalAccess({
      access: overlappingExternalAccess,
      event,
      contractSource: info.contractSources[0],
      ctx,
    });
  }
  info.contract?.parameters.forEach((parameter, index) => {
    if (typeof actuals[index] === "number") {
      return;
    }
    const access = parameter.defaultExternalWrite
      ? ("mutable" as const)
      : parameter.defaultExternalRead
        ? ("shared" as const)
        : undefined;
    if (access) {
      checkExternalAccess({
        access,
        event,
        contractSource: info.contractSources[0],
        ctx,
      });
    }
  });
  const resultType = typeOfExpr(expr.id, ctx);
  if (
    typeof resultType === "number" &&
    typeContainsBorrowed(resultType, ctx.typing) &&
    (info.targets.length === 0 ||
      info.contract?.borrowedResult === "external") &&
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
          through:
            info.contract?.borrowedResult === "external"
              ? "an effect operation without declared borrowed-result provenance"
              : "an opaque call without borrowed-result provenance",
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
        (parameter.bindingKind === "value" &&
          (!contract || contract.access === "mutable")) ||
        contract?.retained === true ||
        (contract?.returned === true && !returnsMaterializedProjection) ||
        (contract?.retainedPaths?.length ?? 0) > 0 ||
        (contract?.externalRetainedPaths?.length ?? 0) > 0 ||
        (contract?.borrowedRetainedPaths?.length ?? 0) > 0;
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
    activationKey?: string;
    translatePath?: (
      requested: readonly PlaceProjection[],
    ) => readonly PlaceProjection[] | undefined;
  };
  const translateEffectiveActualPath = (
    effective: EffectiveActual,
    requested: readonly PlaceProjection[],
  ): readonly PlaceProjection[] | undefined =>
    effective.translatePath
      ? effective.translatePath(requested)
      : translateProjectionPath({
          result: effective.result,
          source: effective.source,
          requested,
        });
  const effectiveActualsForParameter = (
    index: number,
    seen = new Set<number>(),
  ): readonly EffectiveActual[] => {
    const actual = actuals[index];
    if (typeof actual === "number") {
      return [
        {
          index,
          actual,
          source: [],
          result: [],
          activationKey: `parameter:${index}`,
        },
      ];
    }
    if (seen.has(index)) {
      return [];
    }
    seen.add(index);
    return (
      info.contract?.parameters[index]?.defaultOrigins?.flatMap((origin) =>
        effectiveActualsForParameter(origin.parameter, new Set(seen)).map(
          (upstream) => ({
            index,
            actual: upstream.actual,
            source: [],
            result: [],
            activationKey: `parameter:${index}`,
            translatePath: (requested) => {
              const translated = translateCallOriginPath({
                info,
                parameterIndex: origin.parameter,
                origin,
                requested,
                ctx,
              });
              return translated === undefined
                ? undefined
                : translateEffectiveActualPath(upstream, translated);
            },
          }),
        ),
      ) ?? []
    );
  };
  const effectiveActuals: readonly EffectiveActual[] = (
    info.contract?.parameters ?? actuals.map(() => undefined)
  ).flatMap((_parameter, index) => effectiveActualsForParameter(index));
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
        return resolveDefaultActualOrigins(origin.parameter, origin.path).map(
          ({ actual, path }) => ({
            index: origin.parameter,
            actual,
            source: [],
            result: [],
            parameter: {
              access,
              ...(access === "shared"
                ? { readPaths: [path] }
                : { writePaths: [path] }),
              retained: false,
              returned: false,
            },
            activationKey: `default:${index}:source:${origin.parameter}`,
          }),
        );
      });
    }) ?? [];
  const localStoragePlacesAtPath = (
    actual: HirExprId,
    path: readonly PlaceProjection[],
  ): readonly BorrowPlace[] =>
    localAggregateStoragePlacesAtProjection(actual, path, ctx) ??
    placesAtProjection(actual, path, ctx, new Set());
  const storagePlacesForEffectiveActual = (
    effective: EffectiveActual,
    path: readonly PlaceProjection[],
  ): readonly BorrowPlace[] => {
    const translated = translateEffectiveActualPath(effective, path);
    return translated
      ? localStoragePlacesAtPath(effective.actual, translated)
      : [];
  };
  const effectiveStorageWriters = [
    ...effectiveActuals,
    ...defaultAccessGroups.flat(),
  ];
  const writtenSlots = effectiveStorageWriters.flatMap((effective) => {
    const parameter =
      effective.parameter ?? info.contract?.parameters[effective.index];
    return (parameter?.writePaths ?? []).flatMap((path) =>
      storagePlacesForEffectiveActual(effective, path),
    );
  });
  const transferredSlots =
    info.contract?.transfers?.flatMap((transfer) =>
      effectiveActuals
        .filter(
          (effective) => effective.index === transfer.destinationParameter,
        )
        .flatMap((effective) =>
          storagePlacesForEffectiveActual(
            effective,
            transfer.destinationPath ?? [],
          ),
        ),
    ) ?? [];
  uniquePlaces([...writtenSlots, ...transferredSlots]).forEach((place) =>
    recordFreshnessInvalidation(place, event, ctx),
  );
  validateBorrowedCallbacks(expr, info, ctx);
  type ActivatedBorrow = {
    index: number;
    actual: HirExprId;
    place: BorrowPlace;
    actor?: SymbolId;
    access: "shared" | "mutable";
    contractPath?: readonly PlaceProjection[];
    activationKey: string;
    externalResult?: true;
  };
  type EffectiveAccess = {
    access: "shared" | "mutable";
    path: readonly PlaceProjection[];
    storageAccess: boolean;
  };
  const accessesForEffectiveActual = ({
    actual,
    index,
    parameter: parameterOverride,
  }: EffectiveActual): readonly EffectiveAccess[] => {
    const parameter = parameterOverride ?? info.contract?.parameters[index];
    const access =
      parameterOverride?.access ??
      parameterAccessFor({ index, actual, info, ctx });
    if (access === "owned") {
      return [];
    }
    return parameter
      ? [
          ...(parameter.readPaths ?? []).map((path) => ({
            access: "shared" as const,
            path,
            storageAccess: true,
          })),
          ...(parameter.writePaths ?? []).map((path) => ({
            access:
              parameter.access === "mutable" ||
              parameter.runtimeCheckedWrites !== true
                ? ("mutable" as const)
                : ("shared" as const),
            path,
            storageAccess: true,
          })),
          ...explicitBorrowAccessPaths(info, index, ctx).map((path) => ({
            access: "shared" as const,
            path,
            storageAccess: false,
          })),
        ]
      : [
          {
            access,
            path: [] as readonly PlaceProjection[],
            storageAccess: false,
          },
        ];
  };
  const activateAccesses = (
    {
      actual,
      index,
      source,
      result,
      parameter: parameterOverride,
      activationKey = `parameter:${index}`,
      translatePath,
    }: EffectiveActual,
    skipSharedResolution = false,
  ): ActivatedBorrow[] => {
    const parameter = parameterOverride ?? info.contract?.parameters[index];
    const access =
      parameterOverride?.access ??
      parameterAccessFor({ index, actual, info, ctx });
    const accesses = accessesForEffectiveActual({
      actual,
      index,
      source,
      result,
      activationKey,
      translatePath,
      ...(parameter ? { parameter } : {}),
    });
    if (
      skipSharedResolution &&
      accesses.every((candidate) => candidate.access === "shared")
    ) {
      return [];
    }
    const actor = baseSymbolOf(actual, ctx);
    return accesses.flatMap(({ access: pathAccess, path, storageAccess }) => {
      const actualPath = translatePath
        ? translatePath(path)
        : translateProjectionPath({
            result,
            source,
            requested: path,
          });
      if (!actualPath) {
        return [];
      }
      const places =
        (storageAccess
          ? localStoragePlacesAtPath(actual, actualPath)
          : undefined) ??
        placesAtProjection(actual, actualPath, ctx, new Set());
      return uniquePlaces(places).map((place) => {
        const effectiveActor = actor ?? place.root;
        const actorInitializer = ctx.bindingInitializers.get(effectiveActor);
        const actorIsSharedCellBorrow =
          typeof actorInitializer === "number" &&
          isSharedCellValueExpression(actorInitializer, ctx);
        const actorIsPlainExternalResult =
          expressionReturnsExternalResult(actual, ctx) &&
          !expressionCarriesBorrowedProvenance(actual, ctx);
        if (
          access === "mutable" &&
          !actorIsSharedCellBorrow &&
          !actorIsPlainExternalResult &&
          !hasMutableCapabilityAt(effectiveActor, event, ctx)
        ) {
          reportMutableCapabilityViolation({
            place,
            actor: effectiveActor,
            event,
            ctx,
          });
        }
        const externalResult = externalResultAccessHint(
          actual,
          ctx,
          actualPath,
        );
        checkAccess({
          place,
          actor,
          access: pathAccess,
          event,
          contractSource: info.contractSources[0],
          externalResult,
          ctx,
        });
        if (pathAccess === "mutable") {
          ctx.mutableStorageSymbols.add(place.root);
        }
        return {
          index,
          actual,
          place,
          actor: effectiveActor,
          access: pathAccess,
          contractPath: path,
          activationKey,
          ...(externalResult === true ? { externalResult: true as const } : {}),
        };
      });
    });
  };
  const externalPlaceRoot = (() => {
    if (expr.exprKind === "call") {
      const callee = ctx.hir.expressions.get(expr.callee);
      if (callee?.exprKind === "identifier") {
        return callee.symbol;
      }
    } else {
      const receiver = baseSymbolOf(expr.target, ctx);
      if (typeof receiver === "number") {
        return receiver;
      }
    }
    const actualRoot = effectiveActuals
      .map(({ actual }) => baseSymbolOf(actual, ctx))
      .find((root): root is SymbolId => typeof root === "number");
    return (
      actualRoot ??
      info.targets.find((target) => target.moduleId === ctx.moduleId)?.symbol ??
      0
    );
  })();
  const defaultBorrowGroups: readonly (readonly ActivatedBorrow[])[] =
    defaultAccessGroups.map((group, index) => {
      const parameter = info.contract?.parameters[index];
      const externalAccess =
        parameter?.defaultExternalWrite ||
        parameter?.defaultWriteOrigins?.some((origin) =>
          defaultProjectionCanBeExternal(origin.parameter, origin.path),
        )
          ? ("mutable" as const)
          : parameter?.defaultExternalRead ||
              parameter?.defaultReadOrigins?.some((origin) =>
                defaultProjectionCanBeExternal(origin.parameter, origin.path),
              )
            ? ("shared" as const)
            : undefined;
      return [
        ...group.flatMap((effective) => activateAccesses(effective)),
        ...(externalAccess
          ? [
              {
                index,
                actual: expr.id,
                place: {
                  root: externalPlaceRoot,
                  projections: [] as readonly PlaceProjection[],
                },
                actor: undefined,
                access: externalAccess,
                activationKey: `default:${index}:external`,
                externalResult: true as const,
              },
            ]
          : []),
      ];
    });
  const defaultLoanGroups: readonly (readonly ActivatedBorrow[])[] =
    info.contract?.parameters.map((parameter, index) => {
      if (
        typeof actuals[index] === "number" ||
        typeof info.signature?.parameters[index]?.type !== "number"
      ) {
        return [];
      }
      const parameterType = info.signature.parameters[index].type;
      return borrowedPathsInType(parameterType, ctx.typing).flatMap(
        (borrowedPath): readonly ActivatedBorrow[] => {
          const access = parameter.writePaths?.some((path) =>
            projectionPathsOverlap(path, borrowedPath),
          )
            ? ("mutable" as const)
            : ("shared" as const);
          const concrete = resolveDefaultActualOrigins(
            index,
            borrowedPath,
          ).flatMap(({ actual, path }) => {
            const actor = baseSymbolOf(actual, ctx);
            const externalResult =
              externalResultAccessHint(actual, ctx, path) === true;
            return uniquePlaces(
              placesAtProjection(actual, path, ctx, new Set()),
            ).map((place) => ({
              index,
              actual,
              place,
              actor,
              access,
              activationKey: `default-loan:${index}`,
              ...(externalResult ? { externalResult: true as const } : {}),
            }));
          });
          const external = defaultProjectionCanBeExternal(index, borrowedPath)
            ? [
                {
                  index,
                  actual: expr.id,
                  place: {
                    root: externalPlaceRoot,
                    projections: borrowedPath,
                  },
                  actor: undefined,
                  access,
                  activationKey: `default-loan:${index}`,
                  externalResult: true as const,
                },
              ]
            : [];
          return [...concrete, ...external];
        },
      );
    }) ?? [];
  const skipSharedCallAccessResolution =
    !effectiveActuals.some((effective) =>
      accessesForEffectiveActual(effective).some(
        (access) => access.access === "mutable",
      ),
    ) &&
    !defaultBorrowGroups.flat().some((borrow) => borrow.access === "mutable") &&
    !defaultLoanGroups.flat().some((borrow) => borrow.access === "mutable") &&
    overlappingExternalAccess !== "mutable" &&
    !allAliases(ctx).some(
      (alias) =>
        alias.provenance === "storage-borrow" &&
        alias.access === "mutable" &&
        aliasActiveAt(alias, event, ctx),
    );
  const borrows = effectiveActuals.flatMap((effective) => {
    return activateAccesses(effective, skipSharedCallAccessResolution);
  });

  const stableExpressionIdentity = (
    exprId: HirExprId,
    seen = new Set<HirExprId>(),
  ): string => {
    if (seen.has(exprId)) {
      return `recursive:${exprId}`;
    }
    seen.add(exprId);
    const expression = ctx.hir.expressions.get(exprId);
    if (!expression) {
      return `missing:${exprId}`;
    }
    if (expression.exprKind === "identifier") {
      return `symbol:${expression.symbol}`;
    }
    if (expression.exprKind === "literal") {
      return `literal:${expression.literalKind}:${expression.value}`;
    }
    if (
      expression.exprKind === "block" &&
      typeof expression.value === "number"
    ) {
      return stableExpressionIdentity(expression.value, seen);
    }
    if (
      expression.exprKind === "call" &&
      intrinsicNameForCall(expression, ctx) === "~" &&
      expression.args[0]
    ) {
      return stableExpressionIdentity(expression.args[0].expr, seen);
    }
    if (
      expression.exprKind === "method-call" &&
      (expression.method === "at" || expression.method === "get") &&
      expression.args[0]
    ) {
      return [
        expression.method,
        stableExpressionIdentity(expression.target, new Set(seen)),
        stableExpressionIdentity(expression.args[0].expr, new Set(seen)),
      ].join(":");
    }
    if (
      expression.exprKind === "call" &&
      intrinsicNameForCall(expression, ctx) === "__array_get" &&
      expression.args.length === 2
    ) {
      return [
        "__array_get",
        stableExpressionIdentity(expression.args[0]!.expr, new Set(seen)),
        stableExpressionIdentity(expression.args[1]!.expr, new Set(seen)),
      ].join(":");
    }
    return `expr:${exprId}`;
  };
  const runtimeComparableReference = (borrow: ActivatedBorrow): boolean => {
    const actualType = typeOfExpr(borrow.actual, ctx);
    const parameterType = info.signature?.parameters[borrow.index]?.type;
    return [actualType, parameterType].some(
      (type) =>
        typeof type === "number" && typeIsAllocationBacked(type, ctx.typing),
    );
  };
  const runtimeIdentity = (
    borrow: ActivatedBorrow,
  ):
    | Pick<RuntimeIdentityGuard["left"], "identity" | "allocationPath">
    | undefined => {
    const parameter = info.contract?.parameters[borrow.index];
    const paths = borrow.contractPath
      ? [borrow.contractPath]
      : [...(parameter?.readPaths ?? []), ...(parameter?.writePaths ?? [])];
    if (paths.length === 0) {
      return undefined;
    }
    const dynamicIndexes = borrow.place.projections.filter(
      (projection) =>
        projection.kind === "index" &&
        projection.stable &&
        projection.constant === undefined,
    );
    if (
      info.signature?.parameters[borrow.index]?.bindingKind === "mutable-ref" &&
      paths.every((path) => path.length === 0) &&
      parameter?.invalidatedPaths?.some((path) => path.length === 0) === true
    ) {
      const dynamicIndex = borrow.place.projections.findIndex(
        (projection) =>
          projection.kind === "index" &&
          projection.stable &&
          projection.constant === undefined,
      );
      const indexFullyIdentifiesStorage =
        dynamicIndex >= 0 &&
        borrow.place.projections
          .slice(dynamicIndex + 1)
          .every((projection) => projection.kind === "identity");
      const isCanonicalRootStorage = borrow.place.projections.every(
        (projection) => projection.kind === "identity",
      );
      return dynamicIndexes.length === 0 && isCanonicalRootStorage
        ? { identity: "storage" }
        : dynamicIndexes.length === 1 && indexFullyIdentifiesStorage
          ? { identity: "indexed-place" }
          : undefined;
    }
    const dereferenceStates = new Set(
      paths.map((path) =>
        path.some((projection) => projection.kind === "dereference"),
      ),
    );
    if (dereferenceStates.size !== 1) {
      return undefined;
    }
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
        firstPath.some(
          (projection) =>
            projection.kind !== "field" &&
            projection.kind !== "tuple" &&
            projection.kind !== "dereference" &&
            projection.kind !== "identity",
        ) ||
        allocationPaths.some(
          (path) => JSON.stringify(path) !== JSON.stringify(firstPath),
        )
      ) {
        return undefined;
      }
      const parameterType = info.signature?.parameters[borrow.index]?.type;
      return typeof parameterType === "number" &&
        projectedTypes(parameterType, firstPath, ctx.typing).some((type) =>
          typeIsAllocationBacked(type, ctx.typing),
        )
        ? { identity: "allocation", allocationPath: firstPath }
        : undefined;
    }
    if (dynamicIndexes.length === 1) {
      return runtimeComparableReference(borrow) &&
        paths.every((path) => path.length > 0)
        ? { identity: "allocation", allocationPath: [] }
        : { identity: "indexed-place" };
    }
    return dynamicIndexes.length === 0 && runtimeComparableReference(borrow)
      ? { identity: "allocation", allocationPath: [] }
      : undefined;
  };
  const allocationIdentityTypes = (
    borrow: ActivatedBorrow,
    identity: Pick<RuntimeIdentityGuard["left"], "identity" | "allocationPath">,
  ): readonly TypeId[] => {
    if (identity.identity !== "allocation") {
      return [];
    }
    const parameterType = info.signature?.parameters[borrow.index]?.type;
    if (typeof parameterType !== "number") {
      return [];
    }
    return identity.allocationPath && identity.allocationPath.length > 0
      ? projectedTypes(parameterType, identity.allocationPath, ctx.typing)
      : [parameterType];
  };
  type AllocationIdentityDomain = {
    category: "function" | "array" | "object";
    nominal?: TypeId;
  };
  const allocationIdentityDomain = (type: TypeId): AllocationIdentityDomain => {
    const desc = ctx.typing.arena.get(type);
    if (desc.kind === "borrowed") {
      return allocationIdentityDomain(desc.inner);
    }
    if (desc.kind === "recursive") {
      return allocationIdentityDomain(
        ctx.typing.arena.substitute(desc.body, new Map([[desc.binder, type]])),
      );
    }
    if (desc.kind === "function") {
      return { category: "function" };
    }
    if (desc.kind === "fixed-array") {
      return { category: "array" };
    }
    const nominal = ctx.typing.arena.nominalComponent(type);
    return {
      category: "object",
      ...(typeof nominal === "number" ? { nominal } : {}),
    };
  };
  const nominalCanOverlap = (left: TypeId, right: TypeId): boolean => {
    if (left === right) {
      return true;
    }
    const extendsNominal = (actual: TypeId, expected: TypeId): boolean => {
      const seen = new Set<TypeId>();
      let current: TypeId | undefined = actual;
      while (typeof current === "number" && !seen.has(current)) {
        if (current === expected) {
          return true;
        }
        seen.add(current);
        current = ctx.typing.objectsByNominal.get(current)?.baseNominal;
      }
      return false;
    };
    return extendsNominal(left, right) || extendsNominal(right, left);
  };
  const allocationIdentityDomainsOverlap = (
    leftTypes: readonly TypeId[],
    rightTypes: readonly TypeId[],
  ): boolean =>
    leftTypes.length > 0 &&
    rightTypes.length > 0 &&
    leftTypes.some((leftType) =>
      rightTypes.some((rightType) => {
        const left = allocationIdentityDomain(leftType);
        const right = allocationIdentityDomain(rightType);
        if (left.category !== right.category) {
          return false;
        }
        if (
          typeof left.nominal !== "number" ||
          typeof right.nominal !== "number"
        ) {
          return true;
        }
        return nominalCanOverlap(left.nominal, right.nominal);
      }),
    );
  const allocationIdentityDomainsCanOverlap = (
    left: ActivatedBorrow,
    right: ActivatedBorrow,
    leftIdentity: Pick<
      RuntimeIdentityGuard["left"],
      "identity" | "allocationPath"
    >,
    rightIdentity: Pick<
      RuntimeIdentityGuard["right"],
      "identity" | "allocationPath"
    >,
  ): boolean => {
    if (
      leftIdentity.identity !== "allocation" ||
      rightIdentity.identity !== "allocation"
    ) {
      return true;
    }
    return allocationIdentityDomainsOverlap(
      allocationIdentityTypes(left, leftIdentity),
      allocationIdentityTypes(right, rightIdentity),
    );
  };
  const callScopedLoanRootDomainsCanOverlap = (
    left: ActivatedBorrow,
    right: ActivatedBorrow,
  ): boolean => {
    const leftType = info.signature?.parameters[left.index]?.type;
    const rightType = info.signature?.parameters[right.index]?.type;
    if (
      typeof leftType !== "number" ||
      typeof rightType !== "number" ||
      !typeIsAllocationBacked(leftType, ctx.typing) ||
      !typeIsAllocationBacked(rightType, ctx.typing)
    ) {
      return true;
    }
    return allocationIdentityDomainsOverlap([leftType], [rightType]);
  };
  const parameterFormsCallScopedLoan = (borrow: ActivatedBorrow): boolean => {
    const parameter = info.signature?.parameters[borrow.index];
    return (
      parameter?.bindingKind === "mutable-ref" ||
      (typeof parameter?.type === "number" &&
        typeContainsBorrowed(parameter.type, ctx.typing))
    );
  };
  const pathsHaveBoundedDynamicUncertainty = (
    left: BorrowPlace,
    right: BorrowPlace,
    leftIdentity: Pick<
      RuntimeIdentityGuard["left"],
      "identity" | "allocationPath"
    >,
    rightIdentity: Pick<
      RuntimeIdentityGuard["right"],
      "identity" | "allocationPath"
    >,
  ): boolean => {
    const allocationOriginPlace = (
      place: BorrowPlace,
      identity: Pick<
        RuntimeIdentityGuard["left"],
        "identity" | "allocationPath"
      >,
    ): BorrowPlace =>
      identity.identity === "allocation" &&
      (identity.allocationPath?.length ?? 0) === 0
        ? {
            root: place.root,
            projections: [{ kind: "dereference" }],
          }
        : place;
    const identityUsesRootAllocation = (
      identity: Pick<
        RuntimeIdentityGuard["left"],
        "identity" | "allocationPath"
      >,
    ): boolean =>
      identity.identity === "allocation" &&
      (identity.allocationPath?.length ?? 0) === 0;
    const leftFresh = identityUsesRootAllocation(leftIdentity)
      ? freshAllocationOriginOfPlace(
          allocationOriginPlace(left, leftIdentity),
          ctx,
          event,
        )
      : undefined;
    const rightFresh = identityUsesRootAllocation(rightIdentity)
      ? freshAllocationOriginOfPlace(
          allocationOriginPlace(right, rightIdentity),
          ctx,
          event,
        )
      : undefined;
    if (
      left.root !== right.root &&
      (typeof leftFresh === "number" || typeof rightFresh === "number") &&
      leftFresh !== rightFresh
    ) {
      return false;
    }
    if (
      leftIdentity.identity === "allocation" &&
      rightIdentity.identity === "allocation"
    ) {
      const leftDereference = left.projections.findLastIndex(
        (projection) => projection.kind === "dereference",
      );
      const rightDereference = right.projections.findLastIndex(
        (projection) => projection.kind === "dereference",
      );
      if (leftDereference >= 0 && rightDereference >= 0) {
        return projectionPathsOverlap(
          left.projections.slice(leftDereference + 1),
          right.projections.slice(rightDereference + 1),
        );
      }
    }
    if (left.root !== right.root) {
      const leftDeref = left.projections.findLastIndex(
        (projection) => projection.kind === "dereference",
      );
      const rightDeref = right.projections.findLastIndex(
        (projection) => projection.kind === "dereference",
      );
      return projectionPathsOverlap(
        left.projections.slice(leftDeref + 1),
        right.projections.slice(rightDeref + 1),
      );
    }
    const length = Math.min(left.projections.length, right.projections.length);
    let dynamic = false;
    for (let index = 0; index < length; index += 1) {
      const leftProjection = left.projections[index]!;
      const rightProjection = right.projections[index]!;
      if (JSON.stringify(leftProjection) === JSON.stringify(rightProjection)) {
        if (
          leftProjection.kind === "index" &&
          leftProjection.stable &&
          leftProjection.constant === undefined
        ) {
          dynamic = true;
        }
        continue;
      }
      if (
        leftProjection.kind !== "index" ||
        rightProjection.kind !== "index" ||
        !leftProjection.stable ||
        !rightProjection.stable
      ) {
        return false;
      }
      if (
        leftProjection.constant !== undefined &&
        rightProjection.constant !== undefined &&
        leftProjection.constant !== rightProjection.constant
      ) {
        return false;
      }
      dynamic = true;
    }
    return dynamic;
  };
  const tryRecordRuntimeIdentityGuard = (
    left: ActivatedBorrow,
    right: ActivatedBorrow,
  ): boolean => {
    const omittedParameters =
      info.signature?.parameters.flatMap((parameter, index) =>
        parameter.defaulted === true && typeof actuals[index] !== "number"
          ? [index]
          : [],
      ) ?? [];
    const leftIdentity = runtimeIdentity(left);
    const rightIdentity = runtimeIdentity(right);
    const identityStoragePlaces = (
      borrow: ActivatedBorrow,
    ): readonly BorrowPlace[] => {
      const handleSlots = borrow.place.projections.flatMap(
        (projection, index) =>
          projection.kind === "dereference"
            ? [
                {
                  root: borrow.place.root,
                  projections: borrow.place.projections.slice(0, index),
                },
              ]
            : [],
      );
      return handleSlots.length > 0
        ? handleSlots
        : [{ root: borrow.place.root, projections: [] }];
    };
    if (
      !info.contract ||
      !callableContractAllowsRuntimeIdentityGuards(info.contract) ||
      (!info.target && info.targets.length === 0) ||
      typeof actuals[left.index] !== "number" ||
      typeof actuals[right.index] !== "number" ||
      !parameterFormsCallScopedLoan(left) ||
      !parameterFormsCallScopedLoan(right) ||
      (omittedParameters.length > 0 &&
        (info.traitDispatch ||
          !info.target ||
          info.contract.defaultIdentityGuardProtocol !==
            "presence-conflict-bit-v1" ||
          !callableDefaultsPreserveRuntimeIdentity({
            contract: info.contract,
            omittedParameters,
            writePreservesIdentity: (origin) => {
              const writtenPlaces = resolveDefaultActualOrigins(
                origin.parameter,
                origin.path,
              ).flatMap(({ actual, path }) =>
                localStoragePlacesAtPath(actual, path),
              );
              return (
                writtenPlaces.length > 0 &&
                writtenPlaces.every(
                  (place) =>
                    !placeOverlaps(place, left.place, ctx, event) &&
                    !placeOverlaps(place, right.place, ctx, event) &&
                    [
                      ...identityStoragePlaces(left),
                      ...identityStoragePlaces(right),
                    ].every(
                      (storage) => !placeOverlaps(place, storage, ctx, event),
                    ),
                )
              );
            },
          }))) ||
      runtimeIdentityGuardParameterCanEscape(
        info.contract.parameters[left.index],
      ) ||
      runtimeIdentityGuardParameterCanEscape(
        info.contract.parameters[right.index],
      ) ||
      !leftIdentity ||
      !rightIdentity ||
      leftIdentity.identity !== rightIdentity.identity ||
      !allocationIdentityDomainsCanOverlap(
        left,
        right,
        leftIdentity,
        rightIdentity,
      ) ||
      !pathsHaveBoundedDynamicUncertainty(
        left.place,
        right.place,
        leftIdentity,
        rightIdentity,
      )
    ) {
      return false;
    }
    if (
      stableExpressionIdentity(left.actual) ===
      stableExpressionIdentity(right.actual)
    ) {
      return false;
    }
    const guard: RuntimeIdentityGuard = {
      call: expr.id,
      target: info.target ?? info.targets[0]!,
      left: {
        parameter: left.index,
        expression: left.actual,
        place: left.place,
        display: `argument ${left.index + 1} place ${placeName(left.place, ctx)}`,
        ...leftIdentity,
      },
      right: {
        parameter: right.index,
        expression: right.actual,
        place: right.place,
        display: `argument ${right.index + 1} place ${placeName(right.place, ctx)}`,
        ...rightIdentity,
      },
      ...(omittedParameters.length > 0
        ? {
            afterDefaults: true as const,
            defaultIdentityGuardProtocol: "presence-conflict-bit-v1" as const,
            omittedParameters,
          }
        : {}),
    };
    const guards = ctx.runtimeIdentityGuards.get(expr.id) ?? [];
    const key = `${guard.left.parameter}:${guard.right.parameter}:${guard.left.display}:${guard.right.display}`;
    if (
      !guards.some(
        (candidate) =>
          `${candidate.left.parameter}:${candidate.right.parameter}:${candidate.left.display}:${candidate.right.display}` ===
          key,
      )
    ) {
      guards.push(guard);
      ctx.runtimeIdentityGuards.set(expr.id, guards);
    }
    return true;
  };
  const reportBorrowConflicts = (
    activatedBorrows: readonly ActivatedBorrow[],
  ): void => {
    const borrowIsCallLocal = (borrow: ActivatedBorrow): boolean => {
      if (borrow.externalResult === true) {
        return false;
      }
      const record = ctx.symbolTable.getSymbol(borrow.place.root);
      return (
        !ctx.parameterSymbols.has(borrow.place.root) &&
        ctx.symbolTable.getScope(record.scope).kind !== "module"
      );
    };
    const borrowRootIsIndependentInlineValue = (
      borrow: ActivatedBorrow,
    ): boolean => {
      if (!borrowIsCallLocal(borrow)) {
        return false;
      }
      const rootType = ctx.typing.valueTypes.get(borrow.place.root);
      const staysWithinInlineStorage = borrow.place.projections.every(
        (projection) =>
          projection.kind === "field" ||
          projection.kind === "tuple" ||
          projection.kind === "index" ||
          projection.kind === "discriminant",
      );
      return (
        typeof rootType === "number" &&
        !typeIsAllocationBacked(rootType, ctx.typing) &&
        !typeContainsBorrowed(rootType, ctx.typing) &&
        staysWithinInlineStorage
      );
    };
    const activationGroups = Array.from(
      activatedBorrows
        .reduce((groups, borrow) => {
          const group = groups.get(borrow.activationKey) ?? [];
          group.push(borrow);
          groups.set(borrow.activationKey, group);
          return groups;
        }, new Map<string, ActivatedBorrow[]>())
        .values(),
    );
    activationGroups.forEach((leftGroup, groupIndex) => {
      activationGroups.slice(groupIndex + 1).forEach((rightGroup) => {
        leftGroup.forEach((left) => {
          rightGroup.forEach((right) => {
            if (
              (left.externalResult === true && borrowIsCallLocal(right)) ||
              (right.externalResult === true && borrowIsCallLocal(left))
            ) {
              return;
            }
            if (left.access === "shared" && right.access === "shared") {
              return;
            }
            if (
              left.externalResult !== true &&
              right.externalResult !== true &&
              !placeOverlaps(left.place, right.place, ctx, event)
            ) {
              if (
                borrowRootIsIndependentInlineValue(left) ||
                borrowRootIsIndependentInlineValue(right)
              ) {
                return;
              }
              if (
                !parameterFormsCallScopedLoan(left) ||
                !parameterFormsCallScopedLoan(right)
              ) {
                return;
              }
              const accessIsConfinedToRoot = (place: BorrowPlace): boolean => {
                let crossedRootAllocation = false;
                let reachedPrivateStorage = false;
                return place.projections.every((projection) => {
                  if (projection.kind === "identity") {
                    return true;
                  }
                  if (projection.kind === "dereference") {
                    if (crossedRootAllocation || reachedPrivateStorage) {
                      return false;
                    }
                    crossedRootAllocation = true;
                    return true;
                  }
                  if (isPrivateSummaryRegionProjection(projection)) {
                    reachedPrivateStorage = true;
                    return true;
                  }
                  return false;
                });
              };
              const leftFresh = freshAllocationOriginOfPlace(
                {
                  root: left.place.root,
                  projections: [{ kind: "dereference" }],
                },
                ctx,
                event,
              );
              const rightFresh = freshAllocationOriginOfPlace(
                {
                  root: right.place.root,
                  projections: [{ kind: "dereference" }],
                },
                ctx,
                event,
              );
              if (
                left.place.root !== right.place.root &&
                accessIsConfinedToRoot(left.place) &&
                accessIsConfinedToRoot(right.place) &&
                (typeof leftFresh === "number" ||
                  typeof rightFresh === "number") &&
                leftFresh !== rightFresh
              ) {
                return;
              }
              const leftIdentity = runtimeIdentity(left);
              const rightIdentity = runtimeIdentity(right);
              const identityUsesParameterRoot = (
                identity:
                  | Pick<
                      RuntimeIdentityGuard["left"],
                      "identity" | "allocationPath"
                    >
                  | undefined,
              ): boolean =>
                identity?.identity === "allocation" &&
                (identity.allocationPath?.length ?? 0) === 0;
              if (
                identityUsesParameterRoot(leftIdentity) &&
                identityUsesParameterRoot(rightIdentity) &&
                !callScopedLoanRootDomainsCanOverlap(left, right)
              ) {
                return;
              }
              if (
                isPrivateSummaryRegionProjection(left.place.projections[0]) &&
                isPrivateSummaryRegionProjection(right.place.projections[0]) &&
                accessIsConfinedToRoot(left.place) &&
                accessIsConfinedToRoot(right.place)
              ) {
                const leftPrivateFresh = freshAllocationOriginOfPlace(
                  {
                    root: left.place.root,
                    projections: [{ kind: "dereference" }],
                  },
                  ctx,
                  event,
                );
                const rightPrivateFresh = freshAllocationOriginOfPlace(
                  {
                    root: right.place.root,
                    projections: [{ kind: "dereference" }],
                  },
                  ctx,
                  event,
                );
                if (
                  !callScopedLoanRootDomainsCanOverlap(left, right) ||
                  ((typeof leftPrivateFresh === "number" ||
                    typeof rightPrivateFresh === "number") &&
                    leftPrivateFresh !== rightPrivateFresh)
                ) {
                  return;
                }
              }
              if (tryRecordRuntimeIdentityGuard(left, right)) {
                return;
              }
              if (
                leftIdentity &&
                rightIdentity &&
                !allocationIdentityDomainsCanOverlap(
                  left,
                  right,
                  leftIdentity,
                  rightIdentity,
                )
              ) {
                return;
              }
              const mayOverlapAtRuntime = pathsHaveBoundedDynamicUncertainty(
                left.place,
                right.place,
                leftIdentity ?? { identity: "indexed-place" },
                rightIdentity ?? { identity: "indexed-place" },
              );
              if (!mayOverlapAtRuntime) {
                return;
              }
            }
            if (tryRecordRuntimeIdentityGuard(left, right)) {
              return;
            }
            const leftPlace =
              left.externalResult === true
                ? localizeExternalResultPlace(left.place, externalPlaceRoot)
                : left.place;
            const rightPlace =
              right.externalResult === true
                ? localizeExternalResultPlace(right.place, externalPlaceRoot)
                : right.place;
            const synthetic: AliasDefinition = {
              symbol:
                left.externalResult === true
                  ? externalPlaceRoot
                  : (left.actor ?? left.place.root),
              place: leftPlace,
              access: left.access,
              provenance: "storage-borrow",
              span: ctx.hir.expressions.get(left.actual)?.span ?? event.span,
              event,
              uses: [event],
              ...(left.externalResult === true ? { externalResult: true } : {}),
            };
            reportConflict({
              attempted: rightPlace,
              access: right.access,
              existing: synthetic,
              event: ctx.events.get(right.actual) ?? event,
              contractSource: info.contractSources[0],
              ctx,
            });
          });
        });
      });
    });
  };
  const activeDefaultLoans: ActivatedBorrow[] = [];
  defaultBorrowGroups.forEach((group, index) => {
    reportBorrowConflicts([...activeDefaultLoans, ...group]);
    activeDefaultLoans.push(...(defaultLoanGroups[index] ?? []));
  });
  const externalBodyBorrow: readonly ActivatedBorrow[] =
    overlappingExternalAccess === undefined
      ? []
      : [
          {
            index: -1,
            actual: expr.id,
            place: { root: externalPlaceRoot, projections: [] },
            actor: undefined,
            access: overlappingExternalAccess,
            activationKey: "call:external",
            externalResult: true,
          },
        ];
  reportBorrowConflicts([
    ...activeDefaultLoans,
    ...borrows,
    ...externalBodyBorrow,
  ]);
  effectiveActuals.forEach((effectiveActual) => {
    const { actual, index, source } = effectiveActual;
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
              const translated = translateEffectiveActualPath(
                effectiveActual,
                path,
              );
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
    const resolveReturnedActuals = (
      parameterIndex: number,
      requested: readonly PlaceProjection[],
      seenParameters = new Set<number>(),
    ): readonly {
      actual: HirExprId;
      path: readonly PlaceProjection[];
    }[] => {
      const actual = resolved.arguments[parameterIndex];
      if (typeof actual === "number") {
        return [{ actual, path: requested }];
      }
      if (seenParameters.has(parameterIndex)) {
        return [];
      }
      seenParameters.add(parameterIndex);
      return (
        resolved.contract?.parameters[parameterIndex]?.defaultOrigins?.flatMap(
          (origin) => {
            const translated = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested,
            });
            return translated === undefined
              ? []
              : resolveReturnedActuals(
                  origin.parameter,
                  translated,
                  new Set(seenParameters),
                );
          },
        ) ?? []
      );
    };
    const requested = path.map((name) =>
      Number.isInteger(Number(name))
        ? ({ kind: "tuple", index: Number(name) } as const)
        : ({ kind: "field", name } as const),
    );
    const returned =
      resolved.contract?.parameters.flatMap((parameter, index) => {
        if (!parameter.returned) {
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
          return translated === undefined
            ? []
            : resolveReturnedActuals(index, translated);
        });
      }) ?? [];
    return returned.length > 0
      ? mergeCallableValueResolutions(
          returned.map((origin) =>
            callableValueAtPath(
              origin.actual,
              ctx,
              origin.path.flatMap((projection) =>
                projection.kind === "field"
                  ? [projection.name]
                  : projection.kind === "tuple"
                    ? [String(projection.index)]
                    : [],
              ),
              new Set(seen),
            ),
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
  const resolveCallbackActuals = (
    parameterIndex: number,
    requested: readonly PlaceProjection[],
    seen = new Set<number>(),
  ): readonly {
    actual: HirExprId;
    path: readonly PlaceProjection[];
  }[] => {
    const actual = info.arguments[parameterIndex];
    if (typeof actual === "number") {
      return [{ actual, path: requested }];
    }
    if (seen.has(parameterIndex)) {
      return [];
    }
    seen.add(parameterIndex);
    return (
      info.contract?.parameters[parameterIndex]?.defaultOrigins?.flatMap(
        (origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          return translated === undefined
            ? []
            : resolveCallbackActuals(
                origin.parameter,
                translated,
                new Set(seen),
              );
        },
      ) ?? []
    );
  };
  info.contract?.scopedCallbacks?.forEach((scoped) => {
    const requested =
      scoped.callbackPath?.map((part) =>
        Number.isInteger(Number(part))
          ? ({ kind: "tuple", index: Number(part) } as const)
          : ({ kind: "field", name: part } as const),
      ) ?? [];
    const callbacks = resolveCallbackActuals(
      scoped.callbackParameter,
      requested,
    );
    const defaultBehavior =
      callbacks.length === 0 ? scoped.defaultCallbackBehavior : undefined;
    if (
      callbacks.length === 0 &&
      defaultBehavior !== "escapes" &&
      defaultBehavior !== "unknown"
    ) {
      return;
    }
    const resolution =
      callbacks.length === 0
        ? ({ kind: "unknown" } as const)
        : mergeCallableValueResolutions(
            callbacks.map(({ actual, path }) =>
              callableValueAtPath(
                actual,
                ctx,
                path.flatMap((projection) =>
                  projection.kind === "field"
                    ? [projection.name]
                    : projection.kind === "tuple"
                      ? [String(projection.index)]
                      : [],
                ),
              ),
            ),
          );
    if (resolution.kind === "deferred") {
      return;
    }
    const borrowed =
      resolution.kind === "known"
        ? resolution.contract.parameters[scoped.callbackValueParameter]
        : undefined;
    const unknown =
      defaultBehavior === "unknown" ||
      (defaultBehavior === undefined && resolution.kind === "unknown");
    const defaultEscapes = defaultBehavior === "escapes";
    if (
      !unknown &&
      !defaultEscapes &&
      !borrowed?.retained &&
      !borrowed?.returned &&
      !borrowed?.borrowedRetainedPaths
    ) {
      return;
    }
    const callbackExpr = callbacks[0]?.actual;
    const callback =
      typeof callbackExpr === "number"
        ? ctx.hir.expressions.get(callbackExpr)
        : undefined;
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
  const validationKey = `${exprId}:${suppressTerminalAccess ? 1 : 0}`;
  if (ctx.validatedExpressions.has(validationKey)) {
    return;
  }
  ctx.validatedExpressions.add(validationKey);
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
            externalResult: externalResultAccessHint(expr.id, ctx),
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
          const createsAlias = symbols.some(
            (symbol) => aliasesForSymbol(symbol, ctx).length > 0,
          );
          validateExpression(statement.initializer, ctx, createsAlias);
          symbols.forEach((symbol) => {
            const aliases = aliasesForSymbol(symbol, ctx).filter(
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
                const sourceIsPlainExternalResult =
                  expressionReturnsExternalResult(statement.initializer, ctx) &&
                  !expressionCarriesBorrowedProvenance(
                    statement.initializer,
                    ctx,
                  );
                const sourceIsPlainValueProjection =
                  expressionMaterializesPlainProjection(
                    statement.initializer,
                    ctx,
                  ) &&
                  !expressionCarriesBorrowedProvenance(
                    statement.initializer,
                    ctx,
                  );
                if (
                  !sourceMutable &&
                  !sourceIsSharedCellBorrow &&
                  !sourceIsPlainExternalResult &&
                  !sourceIsPlainValueProjection
                ) {
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
          recordFreshnessInvalidation(place, event, ctx);
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
  moduleStorageSymbols,
  mutableStorageSymbols,
  runtimeIdentityGuards,
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
  moduleStorageSymbols: ReadonlySet<SymbolId>;
  mutableStorageSymbols: Set<SymbolId>;
  runtimeIdentityGuards: Map<HirExprId, RuntimeIdentityGuard[]>;
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
  const assignmentAliasesBySymbol = new Map<SymbolId, AliasDefinition[]>();
  parameterBorrowAliases.forEach((alias) => {
    const aliasesForSymbol = assignmentAliasesBySymbol.get(alias.symbol) ?? [];
    aliasesForSymbol.push(alias);
    assignmentAliasesBySymbol.set(alias.symbol, aliasesForSymbol);
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
    assignmentAliasesBySymbol,
    reassignments: [],
    reassignmentsBySymbol: new Map(),
    places,
    mutableOwners,
    events: new Map(),
    uses: new Map(),
    usePlaces: new Map(),
    moduleStorageSymbols,
    mutableStorageSymbols,
    runtimeIdentityGuards,
    diagnostics,
    terminations: [],
    mutableParameters,
    closureCaptures: new Map(),
    bindingInitializers: new Map(),
    initialBindingInitializers: new Map(),
    externalizedPlaces: [],
    freshnessInvalidations: [],
    callResolutionCache: new Map(),
    externalResultCache: new Map(),
    expressionPlacesCache: new Map(),
    expressionPlacesInProgress: new Set(),
    projectedPlacesCache: new Map(),
    projectedPlacesInProgress: new Set(),
    escapedPlacesCache: new Map(),
    validatedExpressions: new Set(),
    analysisComplete: false,
    completedAliasesByRoot: new Map(),
    aliasRootLocality: new Map(),
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
  moduleStorageSymbols,
  mutableStorageSymbols,
  runtimeIdentityGuards,
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
  moduleStorageSymbols: ReadonlySet<SymbolId>;
  mutableStorageSymbols: Set<SymbolId>;
  runtimeIdentityGuards: Map<HirExprId, RuntimeIdentityGuard[]>;
  diagnostics: Diagnostic[];
}): void => {
  const signature = typing.functions.getSignature(functionItem.symbol);
  const declaredTypeId = (
    type: HirFunction["parameters"][number]["type"],
  ): TypeId | undefined => {
    if (!type) {
      return undefined;
    }
    if (typeof type.typeId === "number") {
      return type.typeId;
    }
    if (type.typeKind !== "named" || typeof type.symbol !== "number") {
      return undefined;
    }
    return (
      typing.objects.getTemplate(type.symbol)?.type ??
      typing.intrinsicTypes.get(type.path.at(-1) ?? "")
    );
  };
  const parameterTypesFromBody = new Map<SymbolId, TypeId>();
  if (!signature) {
    walkExpression({
      exprId: functionItem.body,
      hir,
      onEnterExpression: (exprId, expression) => {
        if (
          expression.exprKind !== "identifier" ||
          parameterTypesFromBody.has(expression.symbol)
        ) {
          return;
        }
        const type =
          typing.borrowResolvedExprTypes.get(exprId) ??
          typing.resolvedExprTypes.get(exprId) ??
          typing.table.getExprType(exprId);
        if (typeof type === "number") {
          parameterTypesFromBody.set(expression.symbol, type);
        }
      },
    });
  }
  const parameterTypes =
    signature?.parameters.map((parameter) => parameter.type) ??
    functionItem.parameters.map(
      (parameter) =>
        declaredTypeId(parameter.type) ??
        typing.valueTypes.get(parameter.symbol) ??
        parameterTypesFromBody.get(parameter.symbol),
    );
  const returnType =
    signature?.returnType ??
    declaredTypeId(functionItem.returnType) ??
    typing.borrowResolvedExprTypes.get(functionItem.body) ??
    typing.resolvedExprTypes.get(functionItem.body) ??
    typing.table.getExprType(functionItem.body);
  analyzeCallableBorrowing({
    callable: functionItem,
    parameterTypes,
    returnType,
    borrowedReturnEntries:
      typeof returnType === "number"
        ? borrowedTypeEntriesInType(returnType, typing)
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
    moduleStorageSymbols,
    mutableStorageSymbols,
    runtimeIdentityGuards,
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
  moduleStorageSymbols,
  mutableStorageSymbols,
  runtimeIdentityGuards,
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
  moduleStorageSymbols: ReadonlySet<SymbolId>;
  mutableStorageSymbols: Set<SymbolId>;
  runtimeIdentityGuards: Map<HirExprId, RuntimeIdentityGuard[]>;
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
    moduleStorageSymbols,
    mutableStorageSymbols,
    runtimeIdentityGuards,
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
  moduleStorageSymbols,
  mutableStorageSymbols,
  runtimeIdentityGuards,
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
  moduleStorageSymbols: ReadonlySet<SymbolId>;
  mutableStorageSymbols: Set<SymbolId>;
  runtimeIdentityGuards: Map<HirExprId, RuntimeIdentityGuard[]>;
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
    moduleStorageSymbols,
    mutableStorageSymbols,
    runtimeIdentityGuards,
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
  ctx.analysisComplete = true;
  allAliases(ctx).forEach((alias) => {
    const aliases = ctx.completedAliasesByRoot.get(alias.place.root) ?? [];
    aliases.push(alias);
    ctx.completedAliasesByRoot.set(alias.place.root, aliases);
  });
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
        places.some((place) => placeOverlaps(alias.place, place, ctx, use))
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
