import {
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirPattern,
} from "../hir/index.js";
import type {
  EffectRowId,
  HirExprId,
  SourceSpan,
  SymbolId,
  TypeId,
} from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import {
  callHasIntrinsicBorrowBoundary,
  expressionTypeFor,
  resolveBorrowCallForFacts,
  type ResolvedBorrowCall,
  type ResolveContext,
} from "./call-resolution.js";
import type { CallableBorrowContract, PlaceProjection } from "./model.js";
import {
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";
import { placeOfExpression } from "./places.js";
import { typeContainsBorrowed } from "./borrowed-types.js";
import {
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";

export type CallableBorrowAccessFact = {
  exprId: HirExprId;
  kind: "read" | "write";
  placeId?: number;
  place?: {
    root: SymbolId;
    projections: readonly PlaceProjection[];
  };
};

export type CallableBorrowCallFact = {
  exprId: HirExprId;
  targets: readonly SymbolRef[];
  intrinsic: boolean;
  intrinsicBoundary: boolean;
  intrinsicName?: string;
  substitutions: readonly {
    parameter: number;
    argument?: HirExprId;
    placeId?: number;
  }[];
  formsExplicitBorrow: boolean;
  maySuspend: boolean;
  signature?: ResolvedBorrowCall["signature"];
  baseContract?: CallableBorrowContract;
  contractSources: ResolvedBorrowCall["contractSources"];
  argumentPlanAmbiguous?: true;
  traitDispatch?: true;
  openTraitDispatch?: true;
};

export const stableBorrowCallInput = (
  call: CallableBorrowCallFact,
): Readonly<Record<string, unknown>> => ({
  exprId: call.exprId,
  targets: call.targets,
  intrinsic: call.intrinsic,
  intrinsicBoundary: call.intrinsicBoundary,
  intrinsicName: call.intrinsicName,
  substitutions: call.substitutions,
  formsExplicitBorrow: call.formsExplicitBorrow,
  maySuspend: call.maySuspend,
  signature: call.signature,
  contractSources: call.contractSources,
  argumentPlanAmbiguous: call.argumentPlanAmbiguous,
  traitDispatch: call.traitDispatch,
  openTraitDispatch: call.openTraitDispatch,
});

export type CallableBorrowPlace = {
  id: number;
  root: SymbolId;
  projections: readonly PlaceProjection[];
};

export type CallableBorrowTransferTarget = {
  symbol: SymbolId;
  projections: readonly PlaceProjection[];
  destination?: true;
};

export type CallableBorrowValueRelation = {
  source: HirExprId;
  result: readonly PlaceProjection[];
  sourcePath: readonly PlaceProjection[];
  accessSourcePath?: readonly PlaceProjection[];
};

export type CallableBorrowValueNode = {
  /** First-match nodes model aggregate field/provider precedence. */
  mode: "all" | "first";
  /** Block/branch/handler nodes whose result comes from a fallthrough leaf. */
  controlFlow?: true;
  /** Root aggregates are values in their own right; only project through them. */
  projectedOnly?: true;
  relations: readonly CallableBorrowValueRelation[];
};

export type CallableBorrowValueRequest = {
  expression: HirExprId;
  requested: readonly PlaceProjection[];
};

export type CallableBorrowOperation =
  | {
      kind: "read" | "write";
      exprId: HirExprId;
      placeId?: number;
      accessRole?:
        | "projection-base"
        | "call-operand"
        | "call-argument"
        | "assignment-target";
    }
  | {
      kind: "move" | "borrow";
      exprId: HirExprId;
      placeId: number;
    }
  | { kind: "define" | "use"; exprId: HirExprId; symbol: SymbolId }
  | {
      kind: "origin-transfer";
      exprId: HirExprId;
      source: HirExprId;
      targets: readonly CallableBorrowTransferTarget[];
    }
  | { kind: "call"; exprId: HirExprId; call: number }
  | {
      kind: "call-argument";
      exprId: HirExprId;
      call: number;
      parameter: number;
      placeId?: number;
    }
  | {
      kind: "return";
      exprId: HirExprId;
      value?: HirExprId;
      span: SourceSpan;
      implicit?: true;
    }
  | { kind: "break" | "continue"; exprId: HirExprId; targetLoop?: HirExprId }
  | {
      kind: "escape";
      exprId: HirExprId;
      span: SourceSpan;
      implicit?: true;
    }
  | { kind: "suspend"; exprId: HirExprId }
  | { kind: "capture"; exprId: HirExprId; symbol: SymbolId; mutable: boolean };

export type CallableBorrowFactBlock = {
  id: number;
  expressions: readonly HirExprId[];
  operations: readonly CallableBorrowOperation[];
  predecessors: readonly number[];
  successors: readonly number[];
};

/**
 * Immutable callable-local syntax and access facts. Contract inference and
 * loan checking share this extraction; neither pass needs another discovery
 * walk merely to decide which bodies, calls, or places are relevant.
 *
 * `stableInput` and `dependencies` form a complete process-local query
 * boundary. V-465 can add invalidation around it without reaching into either
 * solver's private state; durable names and persisted keys intentionally live
 * outside V-472.
 */
export type CallableBorrowFacts = {
  symbol: SymbolId;
  expressionIds: readonly HirExprId[];
  expressions: ReadonlyMap<HirExprId, HirExpression>;
  statements: ReadonlyMap<
    number,
    NonNullable<ReturnType<HirGraph["statements"]["get"]>>
  >;
  expressionTypes: ReadonlyMap<HirExprId, number | undefined>;
  concreteExpressionTypes: ReadonlyMap<HirExprId, number | undefined>;
  places: readonly CallableBorrowPlace[];
  placeForExpression: ReadonlyMap<HirExprId, number>;
  valueNodes: ReadonlyMap<HirExprId, CallableBorrowValueNode>;
  valueUses: ReadonlyMap<HirExprId, readonly HirExprId[]>;
  calls: readonly CallableBorrowCallFact[];
  callForExpression: ReadonlyMap<HirExprId, CallableBorrowCallFact>;
  captures: readonly { symbol: SymbolId; mutable: boolean }[];
  dependencies: readonly SymbolRef[];
  suspensionPoints: readonly HirExprId[];
  returns: readonly { exprId: HirExprId; placeId?: number }[];
  roots: readonly {
    expression: HirExprId;
    entryBlock: number;
    blocks: readonly number[];
  }[];
  entryBlock: number;
  exitBlock: number;
  blocks: readonly CallableBorrowFactBlock[];
  reachableBlocks: ReadonlySet<number>;
  reachableExpressions: ReadonlySet<HirExprId>;
  blockForExpression: ReadonlyMap<HirExprId, number>;
  evaluationOrder: readonly HirExprId[];
  positionForExpression: ReadonlyMap<HirExprId, number>;
  controlForExpression: ReadonlyMap<
    HirExprId,
    {
      path: ReadonlyMap<number, number>;
      loops: ReadonlySet<HirExprId>;
    }
  >;
  loopHeaderForExpression: ReadonlyMap<HirExprId, number>;
  bindingsAfterExpression: ReadonlyMap<
    HirExprId,
    readonly { statementId: number }[]
  >;
  matchBindingsBeforeExpression: ReadonlyMap<
    HirExprId,
    readonly {
      pattern: HirPattern;
      value: HirExprId;
      span: NonNullable<HirPattern["span"]>;
    }[]
  >;
  operations: readonly CallableBorrowOperation[];
  operationsForExpression: ReadonlyMap<
    HirExprId,
    readonly CallableBorrowOperation[]
  >;
  declaredConstraints: {
    contract: HirFunction["borrowContract"];
    parameterTypes: readonly (number | undefined)[];
    returnType?: number;
  };
  liveness: ReadonlyMap<
    SymbolId,
    {
      symbol: SymbolId;
      firstExpression: HirExprId;
      lastExpression: HirExprId;
      liveInBlocks: readonly number[];
      liveOutBlocks: readonly number[];
    }
  >;
  expressionValueLiveness: ReadonlyMap<
    HirExprId,
    { liveInBlocks: readonly number[]; liveOutBlocks: readonly number[] }
  >;
  mutableSymbols: ReadonlySet<SymbolId>;
  hasAssignment: boolean;
  hasReferenceAssignment: boolean;
  hasReferenceState: boolean;
  hasBorrowTypedExpression: boolean;
  hasMutableCapture: boolean;
  hasUnknownExpressionType: boolean;
  hasModuleStorageAccess: boolean;
  hasUnresolvedCall: boolean;
  stableInput: string;
};

/**
 * Resolves structural value flow without consulting HIR. Calls, identifiers,
 * lambdas, and unprojected aggregate roots remain terminal because their
 * meaning depends on the consumer's environment or compact callee contract.
 */
export const factValueRequests = ({
  facts,
  expression,
  requested = [],
  access = false,
  stopAtCalls = false,
}: {
  facts: Pick<CallableBorrowFacts, "valueNodes" | "callForExpression">;
  expression: HirExprId;
  requested?: readonly PlaceProjection[];
  access?: boolean;
  stopAtCalls?: boolean;
}): readonly CallableBorrowValueRequest[] => {
  const pending: CallableBorrowValueRequest[] = [{ expression, requested }];
  const terminal = new Map<string, CallableBorrowValueRequest>();
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const key = `${current.expression}:${JSON.stringify(current.requested)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stopAtCalls && facts.callForExpression.has(current.expression)) {
      terminal.set(key, current);
      continue;
    }
    const node = facts.valueNodes.get(current.expression);
    if (
      !node ||
      (node.projectedOnly === true && current.requested.length === 0)
    ) {
      terminal.set(key, current);
      continue;
    }
    const translated = node.relations.flatMap((relation) => {
      const next = translateValueRequest(relation, current.requested, access);
      return next === undefined
        ? []
        : [{ expression: relation.source, requested: next }];
    });
    const next = node.mode === "first" ? translated.slice(0, 1) : translated;
    if (next.length === 0) {
      terminal.set(key, current);
      continue;
    }
    pending.push(...next);
  }
  return Array.from(terminal.values());
};

export const factControlFlowLeaves = ({
  valueNodes,
  expression,
}: {
  valueNodes: ReadonlyMap<HirExprId, CallableBorrowValueNode>;
  expression: HirExprId;
}): readonly HirExprId[] => {
  const pending = [expression];
  const leaves = new Set<HirExprId>();
  const seen = new Set<HirExprId>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = valueNodes.get(current);
    if (node?.controlFlow !== true) {
      leaves.add(current);
      continue;
    }
    pending.push(...node.relations.map((relation) => relation.source));
  }
  return Array.from(leaves);
};

const translateValueRequest = (
  relation: CallableBorrowValueRelation,
  requested: readonly PlaceProjection[],
  access: boolean,
): readonly PlaceProjection[] | undefined => {
  if (requested.length < relation.result.length) return undefined;
  const matches = relation.result.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(requested[index]),
  );
  return matches
    ? [
        ...(access
          ? (relation.accessSourcePath ?? relation.sourcePath)
          : relation.sourcePath),
        ...requested.slice(relation.result.length),
      ]
    : undefined;
};

class LazyFactsMap<Key, Value> {
  private readonly keySet: ReadonlySet<Key>;

  public constructor(
    private readonly keysList: readonly Key[],
    private readonly create: (key: Key) => Value | undefined,
    private readonly cache: Map<Key, Value> = new Map(),
  ) {
    this.keySet = new Set(keysList);
  }

  public get size(): number {
    return this.keysList.length;
  }

  public get(key: Key): Value | undefined {
    if (!this.keySet.has(key)) return undefined;
    if (!this.cache.has(key)) {
      const value = this.create(key);
      if (value !== undefined) this.cache.set(key, value);
    }
    return this.cache.get(key);
  }

  public has(key: Key): boolean {
    return this.keySet.has(key);
  }

  public keys(): IterableIterator<Key> {
    return this.keysList[Symbol.iterator]();
  }

  public values(): IterableIterator<Value> {
    return this.keysList
      .flatMap((key) => {
        const value = this.get(key);
        return value === undefined ? [] : [value];
      })
      [Symbol.iterator]();
  }

  public entries(): IterableIterator<[Key, Value]> {
    return this.keysList
      .flatMap((key) => {
        const value = this.get(key);
        return value === undefined ? [] : [[key, value] as [Key, Value]];
      })
      [Symbol.iterator]();
  }

  public forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    this.keysList.forEach((key) => {
      const value = this.get(key);
      if (value !== undefined) {
        callbackfn.call(
          thisArg,
          value,
          key,
          this as unknown as ReadonlyMap<Key, Value>,
        );
      }
    });
  }

  public [Symbol.iterator](): IterableIterator<[Key, Value]> {
    return this.entries();
  }

  public materializedCount(): number {
    return this.cache.size;
  }
}

export type LazyCallableBorrowFacts = {
  functions: ReadonlyMap<SymbolId, CallableBorrowFacts>;
  lambdas: ReadonlyMap<HirExprId, CallableBorrowFacts>;
  materializedCount: () => number;
};

export const createLazyCallableBorrowFacts = ({
  functions,
  lambdas,
  hir,
  typing,
  resolveContext,
  functionCache = new Map(),
  lambdaCache = new Map(),
}: {
  functions: readonly HirFunction[];
  lambdas: readonly HirLambdaExpr[];
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
  functionCache?: Map<SymbolId, CallableBorrowFacts>;
  lambdaCache?: Map<HirExprId, CallableBorrowFacts>;
}): LazyCallableBorrowFacts => {
  const functionMap = new Map(
    functions.map(
      (functionItem) => [functionItem.symbol, functionItem] as const,
    ),
  );
  const lambdaMap = new Map(
    lambdas.map((lambda) => [lambda.id, lambda] as const),
  );
  const functionFacts = new LazyFactsMap(
    functions.map((functionItem) => functionItem.symbol),
    (symbol) => {
      const functionItem = functionMap.get(symbol);
      if (!functionItem) return undefined;
      const startedAt = startCompilerPerfPhase();
      const facts = extractFacts({ functionItem, hir, typing, resolveContext });
      markCompilerPerfPhaseDuration(
        "analyzeBorrowing.materializeFullFacts",
        startedAt,
      );
      return facts;
    },
    functionCache,
  );
  const lambdaFacts = new LazyFactsMap(
    lambdas.map((lambda) => lambda.id),
    (exprId) => {
      const lambda = lambdaMap.get(exprId);
      if (!lambda) return undefined;
      const startedAt = startCompilerPerfPhase();
      const facts = extractFacts({
        functionItem: {
          symbol: (-1 - lambda.id) as SymbolId,
          parameters: lambda.parameters,
          body: lambda.body,
          type: typing.resolvedExprTypes.get(lambda.id),
          captures: lambda.captures,
        },
        hir,
        typing,
        resolveContext,
      });
      markCompilerPerfPhaseDuration(
        "analyzeBorrowing.materializeFullFacts",
        startedAt,
      );
      return facts;
    },
    lambdaCache,
  );
  return {
    functions: functionFacts as unknown as ReadonlyMap<
      SymbolId,
      CallableBorrowFacts
    >,
    lambdas: lambdaFacts as unknown as ReadonlyMap<
      HirExprId,
      CallableBorrowFacts
    >,
    materializedCount: () =>
      functionFacts.materializedCount() + lambdaFacts.materializedCount(),
  };
};

type FactCallable = Pick<HirFunction, "symbol" | "parameters" | "body"> & {
  borrowContract?: HirFunction["borrowContract"];
  type?: number;
  captures?: HirLambdaExpr["captures"];
};

const extractFacts = ({
  functionItem,
  hir,
  typing,
  resolveContext,
}: {
  functionItem: FactCallable;
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): CallableBorrowFacts => {
  const expressionIds: HirExprId[] = [];
  const expressionTypes = new Map<HirExprId, number | undefined>();
  const concreteExpressionTypes = new Map<HirExprId, number | undefined>();
  const expressions = new Map<HirExprId, HirExpression>();
  const statements = new Map<
    number,
    NonNullable<ReturnType<HirGraph["statements"]["get"]>>
  >();
  const accesses: CallableBorrowAccessFact[] = [];
  const accessForExpression = new Map<HirExprId, CallableBorrowAccessFact>();
  const calls: CallableBorrowCallFact[] = [];
  const callIndexForExpression = new Map<HirExprId, number>();
  const captures = new Map<SymbolId, { symbol: SymbolId; mutable: boolean }>();
  const dependencies = new Map<string, SymbolRef>();
  const places: CallableBorrowPlace[] = [];
  const placeForExpression = new Map<HirExprId, number>();
  const placeIds = new Map<string, number>();
  const internPlace = (
    place: CallableBorrowAccessFact["place"],
  ): number | undefined => {
    if (!place) {
      return undefined;
    }
    const key = JSON.stringify([place.root, place.projections]);
    const existing = placeIds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = places.length;
    places.push({ id, ...place });
    placeIds.set(key, id);
    return id;
  };
  let hasAssignment = false;
  let hasReferenceAssignment = false;
  let hasReferenceState = false;
  let hasBorrowTypedExpression = false;
  let hasMutableCapture = false;
  let hasUnknownExpressionType = false;
  let hasModuleStorageAccess = false;
  let hasUnresolvedCall = false;
  const suspensionPoints: HirExprId[] = [];
  const liveness = new Map<
    SymbolId,
    { symbol: SymbolId; firstExpression: HirExprId; lastExpression: HirExprId }
  >();
  const mutableSymbols = new Set<SymbolId>();
  const concreteResolveContext: ResolveContext = {
    ...resolveContext,
    borrowIndexMode: "concrete",
    callResolutionCache: undefined,
  };
  const concreteExpressionTypeFor = (exprId: HirExprId) =>
    expressionTypeFor(exprId, concreteResolveContext);

  functionItem.captures?.forEach((capture) => {
    captures.set(capture.symbol, {
      symbol: capture.symbol,
      mutable: capture.mutable,
    });
    hasMutableCapture ||= capture.mutable;
    const captureType = typing.valueTypes.get(capture.symbol);
    if (captureType !== undefined) {
      hasReferenceState ||= typeCanCarryReference(captureType, typing);
      hasBorrowTypedExpression ||= typeContainsBorrowed(captureType, typing);
    } else {
      hasUnknownExpressionType = true;
    }
  });

  const recordPatternFacts = (pattern: HirPattern): void => {
    if (
      pattern.kind === "identifier" &&
      pattern.bindingKind !== undefined &&
      pattern.bindingKind !== "value"
    ) {
      mutableSymbols.add(pattern.symbol);
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach(recordPatternFacts);
    } else if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) => recordPatternFacts(field.pattern));
      if (pattern.spread) recordPatternFacts(pattern.spread);
    } else if (pattern.kind === "type" && pattern.binding) {
      recordPatternFacts(pattern.binding);
    }
  };

  const recordExpression = (
    exprId: HirExprId,
    expression: HirExpression,
  ): void => {
    expressionIds.push(exprId);
    expressions.set(exprId, expression);
    const placeStartedAt = startCompilerPerfPhase();
    const expressionPlace = placeOfExpression(exprId, hir, resolveContext);
    markCompilerPerfPhaseDuration(
      "borrowing.facts.resolvePlace",
      placeStartedAt,
    );
    const expressionPlaceId = internPlace(expressionPlace);
    if (expressionPlaceId !== undefined) {
      placeForExpression.set(exprId, expressionPlaceId);
    }
    if (expression.exprKind === "block") {
      expression.statements.forEach((statementId) => {
        const statement = hir.statements.get(statementId);
        if (statement) statements.set(statementId, statement);
      });
    }
    const typeStartedAt = startCompilerPerfPhase();
    const type = expressionTypeFor(exprId, resolveContext);
    const concreteType = concreteExpressionTypeFor(exprId);
    markCompilerPerfPhaseDuration("borrowing.facts.resolveType", typeStartedAt);
    expressionTypes.set(exprId, type);
    concreteExpressionTypes.set(exprId, concreteType);
    hasUnknownExpressionType ||= typeof concreteType !== "number";
    if (
      typeof concreteType === "number" &&
      typing.arena.get(concreteType).kind !== "function"
    ) {
      hasReferenceState ||= typeCanCarryReference(concreteType, typing);
      hasBorrowTypedExpression ||= typeContainsBorrowed(concreteType, typing);
    }
    if (
      expression.exprKind === "if" ||
      expression.exprKind === "cond" ||
      expression.exprKind === "match"
    ) {
    }
    if (expression.exprKind === "loop" || expression.exprKind === "while") {
    }
    if (expression.exprKind === "assign") {
      hasAssignment = true;
      hasReferenceAssignment ||= [
        expression.value,
        ...(typeof expression.target === "number" ? [expression.target] : []),
      ].some((candidate) => {
        const candidateType = concreteExpressionTypeFor(candidate);
        return (
          typeof candidateType !== "number" ||
          typeCanCarryReference(candidateType, typing)
        );
      });
      if (typeof expression.target === "number") {
        const place = placeOfExpression(expression.target, hir, resolveContext);
        const access = {
          exprId,
          kind: "write",
          place,
          placeId: internPlace(place),
        } satisfies CallableBorrowAccessFact;
        accesses.push(access);
        accessForExpression.set(exprId, access);
      }
    } else if (
      expression.exprKind === "identifier" ||
      expression.exprKind === "field-access"
    ) {
      const access = {
        exprId,
        kind: "read",
        place: expressionPlace,
        placeId: expressionPlaceId,
      } satisfies CallableBorrowAccessFact;
      accesses.push(access);
      accessForExpression.set(exprId, access);
    }
    if (expression.exprKind === "lambda") {
      expression.captures.forEach((capture) => {
        const prior = captures.get(capture.symbol);
        const fact = {
          symbol: capture.symbol,
          mutable: capture.mutable || prior?.mutable === true,
        };
        captures.set(capture.symbol, fact);
        hasMutableCapture ||= fact.mutable;
      });
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const callStartedAt = startCompilerPerfPhase();
      const callee =
        expression.exprKind === "call"
          ? hir.expressions.get(expression.callee)
          : undefined;
      const calleeMetadata =
        callee?.exprKind === "identifier"
          ? (resolveContext.symbolTable.getSymbol(callee.symbol).metadata as
              | { intrinsic?: boolean; intrinsicName?: string }
              | undefined)
          : undefined;
      const intrinsic =
        callee?.exprKind === "identifier" &&
        calleeMetadata?.intrinsic === true &&
        !resolveContext.decls.getEffectOperation(callee.symbol);
      const resolutionStartedAt = startCompilerPerfPhase();
      const resolved = resolveBorrowCallForFacts(expression, resolveContext);
      markCompilerPerfPhaseDuration(
        "borrowing.facts.callResolution",
        resolutionStartedAt,
      );
      markCompilerPerfPhaseDuration(
        intrinsic
          ? "borrowing.facts.callResolution.intrinsic"
          : "borrowing.facts.callResolution.ordinary",
        resolutionStartedAt,
      );
      const targets = resolved.targets;
      const intrinsicBoundary = callHasIntrinsicBorrowBoundary(
        expression,
        resolveContext,
      );
      const substitutionsStartedAt = startCompilerPerfPhase();
      const substitutions = resolved.arguments.map((argument, parameter) => {
        const place =
          typeof argument === "number"
            ? placeOfExpression(argument, hir, resolveContext)
            : undefined;
        return {
          parameter,
          ...(typeof argument === "number" ? { argument } : {}),
          ...(place ? { placeId: internPlace(place) } : {}),
        };
      });
      markCompilerPerfPhaseDuration(
        "borrowing.facts.callSubstitutions",
        substitutionsStartedAt,
      );
      const maySuspend =
        resolved.contract?.maySuspend === true ||
        targets.some((target) => targetMaySuspend(target, resolveContext)) ||
        (resolved.signature !== undefined &&
          !typing.effects.isEmpty(resolved.signature.effectRow));
      const call = {
        exprId,
        targets,
        intrinsic,
        intrinsicBoundary,
        ...(intrinsic
          ? {
              intrinsicName:
                calleeMetadata?.intrinsicName ??
                (callee?.exprKind === "identifier"
                  ? resolveContext.symbolTable.getSymbol(callee.symbol).name
                  : undefined),
            }
          : {}),
        substitutions,
        formsExplicitBorrow:
          resolved.signature?.parameters.some((parameter) =>
            typeContainsBorrowed(parameter.type, typing),
          ) ?? false,
        maySuspend,
        ...(resolved.signature ? { signature: resolved.signature } : {}),
        ...(resolved.contract ? { baseContract: resolved.contract } : {}),
        contractSources: resolved.contractSources,
        ...(resolved.argumentPlanAmbiguous
          ? { argumentPlanAmbiguous: true as const }
          : {}),
        ...(resolved.traitDispatch ? { traitDispatch: true as const } : {}),
        ...(resolved.openTraitDispatch
          ? { openTraitDispatch: true as const }
          : {}),
      } satisfies CallableBorrowCallFact;
      incrementCompilerPerfCounter("borrowing.facts.calls");
      if (intrinsic) {
        incrementCompilerPerfCounter("borrowing.facts.intrinsicCalls");
      }
      callIndexForExpression.set(exprId, calls.length);
      calls.push(call);
      hasUnresolvedCall ||= targets.length === 0 && !intrinsic;
      targets.forEach((target) =>
        dependencies.set(`${target.moduleId}:${target.symbol}`, target),
      );
      if (maySuspend) {
        suspensionPoints.push(exprId);
      }
      markCompilerPerfPhaseDuration(
        "borrowing.facts.resolveCall",
        callStartedAt,
      );
    }
    if (expression.exprKind !== "identifier") {
      return;
    }
    const priorUse = liveness.get(expression.symbol);
    liveness.set(expression.symbol, {
      symbol: expression.symbol,
      firstExpression: priorUse?.firstExpression ?? exprId,
      lastExpression: exprId,
    });
    if (typing.functions.getSignature(expression.symbol) !== undefined) {
      const target = resolveContext.imports.get(expression.symbol) ?? {
        moduleId: resolveContext.moduleId,
        symbol: expression.symbol,
      };
      dependencies.set(`${target.moduleId}:${target.symbol}`, target);
    }
    const record = resolveContext.symbolTable.getSymbol(expression.symbol);
    const isModuleStorage =
      resolveContext.symbolTable.getScope(record.scope).kind === "module" &&
      typing.functions.getSignature(expression.symbol) === undefined;
    hasModuleStorageAccess ||= isModuleStorage;
  };

  const callableType =
    functionItem.type !== undefined
      ? typing.arena.get(functionItem.type)
      : undefined;
  const signature =
    typing.functions.getSignature(functionItem.symbol) ??
    (callableType?.kind === "function" ? callableType : undefined);
  const returnType = signature?.returnType;
  functionItem.parameters.forEach((parameter) =>
    recordPatternFacts(parameter.pattern),
  );
  const flowStartedAt = startCompilerPerfPhase();
  const flow = buildCallableFlowFacts({
    functionItem,
    hir,
    resolveContext,
    accesses,
    accessForExpression,
    calls,
    callIndexForExpression,
    recordExpression,
    recordPattern: recordPatternFacts,
    recordStatement: (statementId, statement) =>
      statements.set(statementId, statement),
  });
  markCompilerPerfPhaseDuration("borrowing.facts.buildFlow", flowStartedAt);
  const valueNodes = buildCallableValueNodes({
    expressions,
    expressionTypes: concreteExpressionTypes,
    calls,
    typing,
  });
  const valueUses = new Map<HirExprId, HirExprId[]>();
  const recordValueUse = (value: HirExprId, consumer: HirExprId): void => {
    const consumers = valueUses.get(value) ?? [];
    if (!consumers.includes(consumer)) consumers.push(consumer);
    valueUses.set(value, consumers);
  };
  valueNodes.forEach((node, consumer) =>
    node.relations.forEach((relation) =>
      recordValueUse(relation.source, consumer),
    ),
  );
  calls.forEach((call) =>
    call.substitutions.forEach((substitution) => {
      if (substitution.argument !== undefined)
        recordValueUse(substitution.argument, call.exprId);
    }),
  );
  const callForExpression = new Map(calls.map((call) => [call.exprId, call]));
  const initiallyReachableBlocks = reachableFactBlocks(
    flow.entryBlock,
    flow.blocks,
  );
  const implicitOperationsByBlock = new Map<
    number,
    CallableBorrowOperation[]
  >();
  factControlFlowLeaves({
    valueNodes,
    expression: functionItem.body,
  }).forEach((exprId) => {
    const blockId = flow.blockForExpression.get(exprId);
    const block = blockId === undefined ? undefined : flow.blocks[blockId];
    const expression = expressions.get(exprId);
    if (
      blockId === undefined ||
      !block ||
      !expression ||
      !initiallyReachableBlocks.has(blockId) ||
      block.operations.some(
        (operation) =>
          (operation.kind === "return" && operation.implicit !== true) ||
          operation.kind === "break" ||
          operation.kind === "continue",
      )
    ) {
      return;
    }
    implicitOperationsByBlock.set(blockId, [
      ...(implicitOperationsByBlock.get(blockId) ?? []),
      {
        kind: "return",
        exprId,
        value: exprId,
        span: expression.span,
        implicit: true,
      },
      {
        kind: "escape",
        exprId,
        span: expression.span,
        implicit: true,
      },
    ]);
  });
  const factBlocks = flow.blocks.map((block) => {
    const implicit = implicitOperationsByBlock.get(block.id);
    return implicit
      ? { ...block, operations: [...block.operations, ...implicit] }
      : block;
  });
  const factOperations = factBlocks.flatMap((block) => block.operations);
  const operationsForExpression = new Map<
    HirExprId,
    CallableBorrowOperation[]
  >();
  factOperations.forEach((operation) => {
    if (operation.kind === "return" && operation.value === undefined) {
      return;
    }
    const current = operationsForExpression.get(operation.exprId);
    if (current) current.push(operation);
    else operationsForExpression.set(operation.exprId, [operation]);
  });
  const returns = factOperations.flatMap((operation) =>
    operation.kind === "return" && operation.value !== undefined
      ? [
          {
            exprId: operation.value,
            ...(placeForExpression.get(operation.value) !== undefined
              ? { placeId: placeForExpression.get(operation.value) }
              : {}),
          },
        ]
      : [],
  );
  const valueLivenessStartedAt = startCompilerPerfPhase();
  const expressionValueLiveness = computeExpressionValueLiveness(
    factBlocks,
    expressions,
    flow.matchBindingsBeforeExpression,
  );
  markCompilerPerfPhaseDuration(
    "borrowing.facts.expressionValueLiveness",
    valueLivenessStartedAt,
  );
  const stableInputStartedAt = startCompilerPerfPhase();
  const stableInput = hashBorrowFactInput({
    symbol: functionItem.symbol,
    signature: signature
      ? {
          parameters: signature.parameters.map((parameter) => [
            parameter.type,
            parameter.bindingKind,
          ]),
          returnType: signature.returnType,
          effectRow: signature.effectRow,
        }
      : undefined,
    borrowContract: functionItem.borrowContract,
    parameters: functionItem.parameters,
    captures: Array.from(captures.values()),
    expressions: expressionIds.map((exprId) => expressions.get(exprId)),
    statements: Array.from(statements),
    expressionTypes: Array.from(expressionTypes),
    concreteExpressionTypes: Array.from(concreteExpressionTypes),
    typeFingerprint: borrowingTypeFingerprint({
      roots: [
        ...Array.from(expressionTypes.values()),
        ...Array.from(concreteExpressionTypes.values()),
        ...(signature?.parameters.map((parameter) => parameter.type) ?? []),
        signature?.returnType,
        ...(functionItem.captures?.map((capture) =>
          typing.valueTypes.get(capture.symbol),
        ) ?? []),
        ...calls.flatMap((call) => [
          ...(call.signature?.parameters.map((parameter) => parameter.type) ??
            []),
          call.signature?.returnType,
        ]),
      ].filter((type): type is TypeId => typeof type === "number"),
      effectRows: [
        signature?.effectRow,
        ...calls.map((call) => call.signature?.effectRow),
      ].filter((row): row is EffectRowId => typeof row === "number"),
      typing,
    }),
    calls: calls.map(stableBorrowCallInput),
    dependencies: Array.from(dependencies.values()),
  });
  markCompilerPerfPhaseDuration(
    "borrowing.facts.stableInput",
    stableInputStartedAt,
  );
  const reachableBlocks = reachableFactBlocks(flow.entryBlock, factBlocks);
  const reachableExpressions = new Set(
    factBlocks.flatMap((block) =>
      reachableBlocks.has(block.id) ? block.expressions : [],
    ),
  );
  const livenessSymbols = new Set([
    ...liveness.keys(),
    ...flow.liveIn.keys(),
    ...flow.liveOut.keys(),
  ]);
  const callableLiveness = new Map(
    Array.from(livenessSymbols, (symbol) => {
      const range = liveness.get(symbol);
      const liveBlocks = new Set([
        ...(flow.liveIn.get(symbol) ?? []),
        ...(flow.liveOut.get(symbol) ?? []),
      ]);
      const liveExpressions = flow.evaluationOrder.filter((exprId) => {
        const block = flow.blockForExpression.get(exprId);
        return block !== undefined && liveBlocks.has(block);
      });
      return [
        symbol,
        {
          symbol,
          firstExpression:
            range?.firstExpression ?? liveExpressions[0] ?? functionItem.body,
          lastExpression:
            range?.lastExpression ??
            liveExpressions.at(-1) ??
            functionItem.body,
          liveInBlocks: flow.liveIn.get(symbol) ?? [],
          liveOutBlocks: flow.liveOut.get(symbol) ?? [],
        },
      ] as const;
    }),
  );
  return {
    symbol: functionItem.symbol,
    expressionIds,
    expressions,
    statements,
    expressionTypes,
    concreteExpressionTypes,
    places,
    placeForExpression,
    valueNodes,
    valueUses,
    calls,
    callForExpression,
    captures: Array.from(captures.values()),
    dependencies: Array.from(dependencies.values()),
    suspensionPoints,
    returns,
    roots: flow.roots,
    entryBlock: flow.entryBlock,
    exitBlock: flow.exitBlock,
    blocks: factBlocks,
    reachableBlocks,
    reachableExpressions,
    blockForExpression: flow.blockForExpression,
    evaluationOrder: flow.evaluationOrder,
    positionForExpression: new Map(
      flow.evaluationOrder.map((exprId, index) => [exprId, index]),
    ),
    controlForExpression: flow.controlForExpression,
    loopHeaderForExpression: flow.loopHeaderForExpression,
    bindingsAfterExpression: flow.bindingsAfterExpression,
    matchBindingsBeforeExpression: flow.matchBindingsBeforeExpression,
    operations: factOperations,
    operationsForExpression,
    declaredConstraints: {
      contract: functionItem.borrowContract,
      parameterTypes:
        signature?.parameters.map((parameter) => parameter.type) ??
        functionItem.parameters.map(() => undefined),
      returnType,
    },
    liveness: callableLiveness,
    expressionValueLiveness,
    mutableSymbols,
    hasAssignment,
    hasReferenceAssignment,
    hasReferenceState,
    hasBorrowTypedExpression,
    hasMutableCapture,
    hasUnknownExpressionType,
    hasModuleStorageAccess,
    hasUnresolvedCall,
    stableInput,
  };
};

type FlowFragment = { entry: number; exits: readonly number[] };

const buildCallableValueNodes = ({
  expressions,
  expressionTypes,
  calls,
  typing,
}: {
  expressions: ReadonlyMap<HirExprId, HirExpression>;
  expressionTypes: ReadonlyMap<HirExprId, number | undefined>;
  calls: readonly CallableBorrowCallFact[];
  typing: TypingResult;
}): ReadonlyMap<HirExprId, CallableBorrowValueNode> => {
  const nodes = new Map<HirExprId, CallableBorrowValueNode>();
  const callFacts = new Map(calls.map((call) => [call.exprId, call]));
  const relation = (
    source: HirExprId,
    result: readonly PlaceProjection[] = [],
    sourcePath: readonly PlaceProjection[] = [],
    accessSourcePath?: readonly PlaceProjection[],
  ): CallableBorrowValueRelation => ({
    source,
    result,
    sourcePath,
    ...(accessSourcePath ? { accessSourcePath } : {}),
  });
  const accessPath = (
    source: HirExprId,
    projection: PlaceProjection,
  ): readonly PlaceProjection[] => {
    const type = expressionTypes.get(source);
    const expression = expressions.get(source);
    const call = callFacts.get(source);
    const transparentBorrow =
      call?.intrinsicBoundary === true &&
      (call.intrinsicName === "~" ||
        call.intrinsicName === "__shared_cell_value");
    const explicitlyBorrowed =
      typeof type === "number" && typing.arena.get(type).kind === "borrowed";
    const dereference =
      typeof type === "number" &&
      typeIsAllocationBacked(type, typing) &&
      !explicitlyBorrowed &&
      !transparentBorrow &&
      expression?.exprKind !== "identifier";
    return dereference ? [{ kind: "dereference" }, projection] : [projection];
  };
  const fieldNamesInType = (
    type: TypeId,
    active = new Set<TypeId>(),
  ): readonly string[] => {
    if (active.has(type)) return [];
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "borrowed") {
      return fieldNamesInType(descriptor.inner, nextActive);
    }
    if (descriptor.kind === "recursive") {
      return fieldNamesInType(descriptor.body, nextActive);
    }
    if (descriptor.kind === "union") {
      return Array.from(
        new Set(
          descriptor.members.flatMap((member) =>
            fieldNamesInType(member, nextActive),
          ),
        ),
      );
    }
    if (descriptor.kind === "intersection") {
      return Array.from(
        new Set(
          [descriptor.nominal, descriptor.structural].flatMap((member) =>
            typeof member === "number"
              ? fieldNamesInType(member, nextActive)
              : [],
          ),
        ),
      );
    }
    if (descriptor.kind === "structural-object") {
      return descriptor.fields.map((field) => field.name);
    }
    if (
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object"
    ) {
      return (
        typing.objectsByNominal.get(type)?.fields.map((field) => field.name) ??
        []
      );
    }
    if (descriptor.kind === "type-param-ref") {
      const constraint = typing.typeParameterConstraints.get(descriptor.param);
      return constraint === undefined
        ? []
        : fieldNamesInType(constraint, nextActive);
    }
    return [];
  };
  expressions.forEach((expression, exprId) => {
    if (expression.exprKind === "field-access") {
      const projection = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      nodes.set(exprId, {
        mode: "all",
        relations: [
          relation(
            expression.target,
            [],
            [projection],
            accessPath(expression.target, projection),
          ),
        ],
      });
      return;
    }
    if (expression.exprKind === "block") {
      if (typeof expression.value === "number") {
        nodes.set(exprId, {
          mode: "all",
          controlFlow: true,
          relations: [relation(expression.value)],
        });
      }
      return;
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      nodes.set(exprId, {
        mode: "all",
        controlFlow: true,
        relations: [
          ...expression.branches.map((branch) => relation(branch.value)),
          ...(typeof expression.defaultBranch === "number"
            ? [relation(expression.defaultBranch)]
            : []),
        ],
      });
      return;
    }
    if (expression.exprKind === "match") {
      nodes.set(exprId, {
        mode: "all",
        controlFlow: true,
        relations: expression.arms.map((arm) => relation(arm.value)),
      });
      return;
    }
    if (expression.exprKind === "effect-handler") {
      nodes.set(exprId, {
        mode: "all",
        controlFlow: true,
        relations: [
          relation(expression.body),
          ...expression.handlers.map((handler) => relation(handler.body)),
        ],
      });
      return;
    }
    if (expression.exprKind === "tuple") {
      nodes.set(exprId, {
        mode: "first",
        projectedOnly: true,
        relations: expression.elements.map((source, index) =>
          relation(source, [{ kind: "tuple", index }]),
        ),
      });
      return;
    }
    if (expression.exprKind === "object-literal") {
      nodes.set(exprId, {
        mode: "first",
        projectedOnly: true,
        relations: [...expression.entries].reverse().flatMap((entry) =>
          entry.kind === "field"
            ? [relation(entry.value, [{ kind: "field", name: entry.name }])]
            : (() => {
                const spreadType = expressionTypes.get(entry.value);
                if (typeof spreadType !== "number") {
                  return [relation(entry.value)];
                }
                return fieldNamesInType(spreadType).map((name) => {
                  const projection = { kind: "field", name } as const;
                  return relation(entry.value, [projection], [projection]);
                });
              })(),
        ),
      });
      return;
    }
    const call = callFacts.get(exprId);
    if (
      expression.exprKind === "call" &&
      call?.intrinsicBoundary === true &&
      (call.intrinsicName === "~" ||
        call.intrinsicName === "__shared_cell_value")
    ) {
      const source = expression.args.at(-1)?.expr;
      if (typeof source === "number") {
        nodes.set(exprId, { mode: "all", relations: [relation(source)] });
      }
      return;
    }
    const indexedSource =
      expression.exprKind === "method-call" &&
      expression.method === "subscript_get"
        ? expression.target
        : expression.exprKind === "call" &&
            call?.intrinsicBoundary === true &&
            call.intrinsicName === "__array_get"
          ? expression.args[0]?.expr
          : undefined;
    const indexExpression =
      expression.exprKind === "method-call" &&
      expression.method === "subscript_get"
        ? expression.args[0]?.expr
        : expression.exprKind === "call"
          ? expression.args[1]?.expr
          : undefined;
    if (typeof indexedSource === "number") {
      const index =
        typeof indexExpression === "number"
          ? expressions.get(indexExpression)
          : undefined;
      const constant =
        index?.exprKind === "literal" && index.literalKind === "i32"
          ? Number(index.value)
          : undefined;
      const indexProjection = {
        kind: "index" as const,
        stable:
          typeof expressionTypes.get(indexedSource) === "number" &&
          typing.arena.get(expressionTypes.get(indexedSource)!).kind ===
            "fixed-array",
        ...(Number.isInteger(constant) ? { constant } : {}),
      };
      nodes.set(exprId, {
        mode: "all",
        relations: [
          relation(
            indexedSource,
            [],
            [indexProjection],
            accessPath(indexedSource, indexProjection),
          ),
        ],
      });
    }
  });
  return nodes;
};

const buildCallableFlowFacts = ({
  functionItem,
  hir,
  resolveContext,
  accesses,
  accessForExpression,
  calls,
  callIndexForExpression,
  recordExpression,
  recordPattern,
  recordStatement,
}: {
  functionItem: Pick<FactCallable, "parameters" | "body">;
  hir: HirGraph;
  resolveContext: ResolveContext;
  accesses: readonly CallableBorrowAccessFact[];
  accessForExpression: ReadonlyMap<HirExprId, CallableBorrowAccessFact>;
  calls: readonly CallableBorrowCallFact[];
  callIndexForExpression: ReadonlyMap<HirExprId, number>;
  recordExpression: (exprId: HirExprId, expression: HirExpression) => void;
  recordPattern: (pattern: HirPattern) => void;
  recordStatement: (
    statementId: number,
    statement: NonNullable<ReturnType<HirGraph["statements"]["get"]>>,
  ) => void;
}): {
  entryBlock: number;
  exitBlock: number;
  roots: CallableBorrowFacts["roots"];
  blocks: readonly CallableBorrowFactBlock[];
  blockForExpression: ReadonlyMap<HirExprId, number>;
  evaluationOrder: readonly HirExprId[];
  controlForExpression: CallableBorrowFacts["controlForExpression"];
  loopHeaderForExpression: CallableBorrowFacts["loopHeaderForExpression"];
  bindingsAfterExpression: CallableBorrowFacts["bindingsAfterExpression"];
  matchBindingsBeforeExpression: CallableBorrowFacts["matchBindingsBeforeExpression"];
  operations: readonly CallableBorrowOperation[];
  liveIn: ReadonlyMap<SymbolId, readonly number[]>;
  liveOut: ReadonlyMap<SymbolId, readonly number[]>;
} => {
  type MutableBlock = {
    id: number;
    expression?: HirExprId;
    operations: CallableBorrowOperation[];
    predecessors: Set<number>;
    successors: Set<number>;
  };
  const blocks = new Map<number, MutableBlock>();
  const blockForExpression = new Map<HirExprId, number>();
  const evaluationOrder: HirExprId[] = [];
  const controlForExpression = new Map<
    HirExprId,
    {
      path: ReadonlyMap<number, number>;
      loops: ReadonlySet<HirExprId>;
    }
  >();
  const loopHeaderForExpression = new Map<HirExprId, number>();
  const bindingsAfterExpression = new Map<
    HirExprId,
    { statementId: number }[]
  >();
  const matchBindingsBeforeExpression = new Map<
    HirExprId,
    {
      pattern: HirPattern;
      value: HirExprId;
      span: NonNullable<HirPattern["span"]>;
    }[]
  >();
  let nextBranch = 0;
  let nextBlock = 0;
  const createBlock = (expression?: HirExprId): MutableBlock => {
    const block: MutableBlock = {
      id: nextBlock++,
      ...(expression !== undefined ? { expression } : {}),
      operations: [],
      predecessors: new Set(),
      successors: new Set(),
    };
    blocks.set(block.id, block);
    if (expression !== undefined) {
      blockForExpression.set(expression, block.id);
    }
    return block;
  };
  const blockFor = (exprId: HirExprId): MutableBlock => {
    const existing = blockForExpression.get(exprId);
    return existing !== undefined ? blocks.get(existing)! : createBlock(exprId);
  };
  const connect = (from: number, to: number): void => {
    blocks.get(from)!.successors.add(to);
    blocks.get(to)!.predecessors.add(from);
  };
  const connectAll = (from: readonly number[], to: number): void =>
    from.forEach((block) => connect(block, to));
  const functionExit = createBlock();
  const attachBaseOperations = (
    exprId: HirExprId,
    expression: HirExpression,
    accessRole?:
      | "projection-base"
      | "call-operand"
      | "call-argument"
      | "assignment-target",
  ): void => {
    const block = blockFor(exprId);
    const access = accessForExpression.get(exprId);
    if (access) {
      block.operations.push({
        kind: access.kind,
        exprId,
        ...(access.placeId !== undefined ? { placeId: access.placeId } : {}),
        ...(accessRole ? { accessRole } : {}),
      });
    }
    if (expression.exprKind === "identifier" && accessRole === undefined) {
      block.operations.push({ kind: "use", exprId, symbol: expression.symbol });
    }
    if (expression.exprKind === "assign") {
      const source = accessForExpression.get(expression.value);
      if (source?.placeId !== undefined) {
        block.operations.push({
          kind: "move",
          exprId,
          placeId: source.placeId,
        });
      }
      block.operations.push({
        kind: "origin-transfer",
        exprId,
        source: expression.value,
        targets: expression.pattern
          ? transferTargetsInPattern(expression.pattern)
          : typeof expression.target === "number"
            ? (() => {
                const target = placeOfExpression(
                  expression.target,
                  hir,
                  resolveContext,
                );
                return target
                  ? [
                      {
                        symbol: target.root,
                        projections: target.projections,
                        destination: true,
                      },
                    ]
                  : [];
              })()
            : [],
      });
    }
    if (expression.exprKind === "lambda") {
      expression.captures.forEach((capture) =>
        block.operations.push({
          kind: "capture",
          exprId,
          symbol: capture.symbol,
          mutable: capture.mutable,
        }),
      );
    }
    const callIndex = callIndexForExpression.get(exprId) ?? -1;
    if (callIndex >= 0) {
      const call = calls[callIndex]!;
      block.operations.push({ kind: "call", exprId, call: callIndex });
      call.substitutions.forEach((substitution) => {
        block.operations.push({
          kind: "call-argument",
          exprId,
          call: callIndex,
          parameter: substitution.parameter,
          ...(substitution.placeId !== undefined
            ? { placeId: substitution.placeId }
            : {}),
        });
        if (
          call.intrinsicBoundary &&
          call.intrinsicName === "~" &&
          substitution.placeId !== undefined
        ) {
          block.operations.push({
            kind: "borrow",
            exprId,
            placeId: substitution.placeId,
          });
        }
      });
    }
    if (callIndex >= 0 && calls[callIndex]!.maySuspend) {
      block.operations.push({ kind: "suspend", exprId });
    }
  };
  const sequence = (fragments: readonly FlowFragment[]): FlowFragment => {
    const first = fragments[0];
    if (!first) {
      const empty = createBlock();
      return { entry: empty.id, exits: [empty.id] };
    }
    let exits = first.exits;
    fragments.slice(1).forEach((fragment) => {
      connectAll(exits, fragment.entry);
      exits = fragment.exits;
    });
    return { entry: first.entry, exits };
  };
  const build = (
    exprId: HirExprId,
    control: {
      path: ReadonlyMap<number, number>;
      loops: ReadonlySet<HirExprId>;
    } = { path: new Map(), loops: new Set() },
    loop?: {
      breakTarget: number;
      continueTarget: number;
      expression: HirExprId;
    },
    accessRole?:
      | "projection-base"
      | "call-operand"
      | "call-argument"
      | "assignment-target",
  ): FlowFragment => {
    const expression = hir.expressions.get(exprId);
    const own = blockFor(exprId);
    if (!expression) {
      return { entry: own.id, exits: [own.id] };
    }
    const recordStartedAt = startCompilerPerfPhase();
    recordExpression(exprId, expression);
    markCompilerPerfPhaseDuration(
      "borrowing.facts.recordExpression",
      recordStartedAt,
    );
    controlForExpression.set(exprId, {
      path: new Map(control.path),
      loops: new Set(control.loops),
    });
    if (expression.exprKind === "assign" && expression.pattern) {
      recordPattern(expression.pattern);
    }
    attachBaseOperations(exprId, expression, accessRole);
    const finish = (fragment: FlowFragment): FlowFragment => {
      evaluationOrder.push(exprId);
      return fragment;
    };
    const finishAfter = (children: readonly HirExprId[]): FlowFragment => {
      const childrenFlow = sequence(
        children.map((child) =>
          build(
            child,
            control,
            loop,
            accessRole === "call-argument" ? accessRole : undefined,
          ),
        ),
      );
      connectAll(childrenFlow.exits, own.id);
      return finish({ entry: childrenFlow.entry, exits: [own.id] });
    };
    const finishAfterOperands = (
      children: readonly {
        exprId: HirExprId;
        accessRole?:
          | "projection-base"
          | "call-operand"
          | "call-argument"
          | "assignment-target";
      }[],
    ): FlowFragment => {
      const childrenFlow = sequence(
        children.map((child) =>
          build(child.exprId, control, loop, child.accessRole),
        ),
      );
      connectAll(childrenFlow.exits, own.id);
      return finish({ entry: childrenFlow.entry, exits: [own.id] });
    };
    switch (expression.exprKind) {
      case "literal":
      case "identifier":
      case "overload-set":
      case "lambda":
        return finish({ entry: own.id, exits: [own.id] });
      case "field-access":
        return finishAfterOperands([
          { exprId: expression.target, accessRole: "projection-base" },
        ]);
      case "tuple":
        return finishAfter(expression.elements);
      case "object-literal":
        return finishAfter(expression.entries.map((entry) => entry.value));
      case "call":
        return finishAfterOperands([
          { exprId: expression.callee, accessRole: "call-operand" },
          ...expression.args.map((argument) => ({
            exprId: argument.expr,
            accessRole: "call-argument" as const,
          })),
        ]);
      case "method-call":
        return finishAfterOperands([
          {
            exprId: expression.target,
            accessRole: "call-argument" as const,
          },
          ...expression.args.map((argument) => ({
            exprId: argument.expr,
            accessRole: "call-argument" as const,
          })),
        ]);
      case "assign": {
        const childrenFlow = sequence([
          ...(typeof expression.target === "number"
            ? [build(expression.target, control, loop, "assignment-target")]
            : []),
          build(expression.value, control, loop),
        ]);
        connectAll(childrenFlow.exits, own.id);
        return finish({ entry: childrenFlow.entry, exits: [own.id] });
      }
      case "block": {
        const fragments: FlowFragment[] = [];
        expression.statements.forEach((statementId) => {
          const statement = hir.statements.get(statementId);
          if (!statement) return;
          recordStatement(statementId, statement);
          if (statement.kind === "let") {
            recordPattern(statement.pattern);
            const fragment = build(statement.initializer, control, loop);
            const initializerBlock = blocks.get(fragment.exits.at(-1)!)!;
            const targets = transferTargetsInPattern(statement.pattern);
            targets.forEach(({ symbol }) =>
              initializerBlock.operations.push({
                kind: "define",
                exprId: statement.initializer,
                symbol,
              }),
            );
            initializerBlock.operations.push({
              kind: "origin-transfer",
              exprId: statement.initializer,
              source: statement.initializer,
              targets,
            });
            bindingsAfterExpression.set(statement.initializer, [
              ...(bindingsAfterExpression.get(statement.initializer) ?? []),
              {
                statementId,
              },
            ]);
            fragments.push(fragment);
            return;
          }
          if (statement.kind === "expr-stmt") {
            fragments.push(build(statement.expr, control, loop));
            return;
          }
          if (typeof statement.value === "number") {
            const returned = build(statement.value, control, loop);
            returned.exits.forEach((exit) => {
              blocks.get(exit)!.operations.push({
                kind: "return",
                exprId: statement.value!,
                value: statement.value!,
                span: statement.span,
              });
              blocks.get(exit)!.operations.push({
                kind: "escape",
                exprId: statement.value!,
                span: statement.span,
              });
              connect(exit, functionExit.id);
            });
            fragments.push({ entry: returned.entry, exits: [] });
            return;
          }
          const returned = createBlock();
          returned.operations.push({
            kind: "return",
            exprId: expression.id,
            span: statement.span,
          });
          connect(returned.id, functionExit.id);
          fragments.push({ entry: returned.id, exits: [] });
        });
        if (typeof expression.value === "number") {
          fragments.push(build(expression.value, control, loop, accessRole));
        }
        if (fragments.length === 0) {
          return finish({ entry: own.id, exits: [own.id] });
        }
        const body = sequence(fragments);
        connectAll(body.exits, own.id);
        return finish({
          entry: body.entry,
          exits: body.exits.length ? [own.id] : [],
        });
      }
      case "if":
      case "cond": {
        const branchId = nextBranch++;
        const branchExits: number[] = [];
        let entry: number | undefined;
        let pendingFalse: readonly number[] = [];
        expression.branches.forEach((branch, index) => {
          const condition = build(branch.condition, control, loop);
          entry ??= condition.entry;
          connectAll(pendingFalse, condition.entry);
          const value = build(
            branch.value,
            {
              ...control,
              path: new Map(control.path).set(branchId, index),
            },
            loop,
            accessRole,
          );
          connectAll(condition.exits, value.entry);
          branchExits.push(...value.exits);
          pendingFalse = condition.exits;
        });
        if (typeof expression.defaultBranch === "number") {
          const fallback = build(
            expression.defaultBranch,
            {
              ...control,
              path: new Map(control.path).set(
                branchId,
                expression.branches.length,
              ),
            },
            loop,
            accessRole,
          );
          entry ??= fallback.entry;
          connectAll(pendingFalse, fallback.entry);
          branchExits.push(...fallback.exits);
        } else {
          branchExits.push(...pendingFalse);
        }
        connectAll(branchExits, own.id);
        return finish({ entry: entry ?? own.id, exits: [own.id] });
      }
      case "match": {
        const branchId = nextBranch++;
        const discriminant = build(expression.discriminant, control, loop);
        const armExits = expression.arms.flatMap((arm, index) => {
          const armControl = {
            ...control,
            path: new Map(control.path).set(branchId, index),
          };
          const evaluationStart = evaluationOrder.length;
          const armFlow = sequence([
            ...(typeof arm.guard === "number"
              ? [build(arm.guard, armControl, loop)]
              : []),
            build(arm.value, armControl, loop, accessRole),
          ]);
          const firstExpression =
            evaluationOrder[evaluationStart] ?? arm.guard ?? arm.value;
          matchBindingsBeforeExpression.set(firstExpression, [
            ...(matchBindingsBeforeExpression.get(firstExpression) ?? []),
            {
              pattern: arm.pattern,
              value: expression.discriminant,
              span: arm.pattern.span ?? expression.span,
            },
          ]);
          connectAll(discriminant.exits, armFlow.entry);
          return armFlow.exits;
        });
        connectAll(armExits, own.id);
        return finish({ entry: discriminant.entry, exits: [own.id] });
      }
      case "effect-handler": {
        const branchId = nextBranch++;
        const bodyBlockStart = nextBlock;
        const body = build(
          expression.body,
          {
            ...control,
            path: new Map(control.path).set(branchId, 0),
          },
          loop,
          accessRole,
        );
        const bodyBlocks = Array.from(blocks.keys()).filter(
          (block) => block >= bodyBlockStart,
        );
        const handlers = expression.handlers.map((handler, index) => {
          handler.parameters.forEach((parameter) =>
            recordPattern({
              kind: "identifier",
              symbol: parameter.symbol,
              bindingKind: parameter.bindingKind,
              span: parameter.span,
            }),
          );
          const fragment = build(
            handler.body,
            {
              ...control,
              path: new Map(control.path).set(branchId, index + 1),
            },
            loop,
            accessRole,
          );
          handler.parameters.forEach((parameter) =>
            blocks.get(fragment.entry)!.operations.unshift({
              kind: "define",
              exprId: handler.body,
              symbol: parameter.symbol,
            }),
          );
          return fragment;
        });
        const alternativeBlocks = new Set(
          Array.from(blocks.keys()).filter((block) => block >= bodyBlockStart),
        );
        handlers.forEach((handler) =>
          bodyBlocks.forEach((block) => connect(block, handler.entry)),
        );
        const exits = [body, ...handlers].flatMap(
          (alternative) => alternative.exits,
        );
        if (typeof expression.finallyBranch === "number") {
          const finalizer = build(expression.finallyBranch, control, loop);
          const terminalTargets = new Set<number>();
          alternativeBlocks.forEach((blockId) => {
            const block = blocks.get(blockId)!;
            if (
              !block.operations.some(
                (operation) =>
                  (operation.kind === "return" && !operation.implicit) ||
                  operation.kind === "break" ||
                  operation.kind === "continue",
              )
            ) {
              return;
            }
            Array.from(block.successors)
              .filter((successor) => !alternativeBlocks.has(successor))
              .forEach((successor) => {
                block.successors.delete(successor);
                blocks.get(successor)?.predecessors.delete(blockId);
                terminalTargets.add(successor);
                connect(blockId, finalizer.entry);
              });
          });
          connectAll(exits, finalizer.entry);
          connectAll(finalizer.exits, own.id);
          terminalTargets.forEach((target) =>
            connectAll(finalizer.exits, target),
          );
        } else {
          connectAll(exits, own.id);
        }
        return finish({ entry: body.entry, exits: [own.id] });
      }
      case "loop": {
        const header = createBlock();
        loopHeaderForExpression.set(expression.id, header.id);
        const body = build(
          expression.body,
          { ...control, loops: new Set([...control.loops, expression.id]) },
          {
            breakTarget: own.id,
            continueTarget: header.id,
            expression: expression.id,
          },
        );
        connect(header.id, body.entry);
        connectAll(body.exits, header.id);
        return finish({ entry: header.id, exits: [own.id] });
      }
      case "while": {
        const header = createBlock();
        loopHeaderForExpression.set(expression.id, header.id);
        const condition = build(expression.condition, control, loop);
        connect(header.id, condition.entry);
        const body = build(
          expression.body,
          { ...control, loops: new Set([...control.loops, expression.id]) },
          {
            breakTarget: own.id,
            continueTarget: header.id,
            expression: expression.id,
          },
        );
        connectAll(condition.exits, body.entry);
        connectAll(condition.exits, own.id);
        connectAll(body.exits, header.id);
        return finish({ entry: header.id, exits: [own.id] });
      }
      case "break": {
        const value =
          typeof expression.value === "number"
            ? build(expression.value, control, loop)
            : { entry: own.id, exits: [own.id] };
        if (typeof expression.value === "number")
          connectAll(value.exits, own.id);
        if (loop) {
          connect(own.id, loop.breakTarget);
          own.operations.push({
            kind: "break",
            exprId,
            targetLoop: loop.expression,
          });
        }
        return finish({ entry: value.entry, exits: [] });
      }
      case "continue":
        if (loop) {
          connect(own.id, loop.continueTarget);
          own.operations.push({
            kind: "continue",
            exprId,
            targetLoop: loop.expression,
          });
        }
        return finish({ entry: own.id, exits: [] });
    }
  };
  const defaults = functionItem.parameters.flatMap((parameter) =>
    typeof parameter.defaultValue === "number" ? [parameter.defaultValue] : [],
  );
  const rootExpressions = [...defaults, functionItem.body];
  const rootFragments = rootExpressions.map((expression) => {
    const firstBlock = nextBlock;
    const fragment = build(expression);
    return {
      expression,
      fragment,
      blocks: Array.from(
        { length: nextBlock - firstBlock },
        (_, index) => firstBlock + index,
      ),
    };
  });
  const callable = sequence(rootFragments.map(({ fragment }) => fragment));
  const entry = createBlock();
  connect(entry.id, callable.entry);
  connectAll(callable.exits, functionExit.id);
  const orderedBlocks = Array.from(blocks.values()).sort(
    (left, right) => left.id - right.id,
  );
  const compacted = compactCallableFlowBlocks({
    blocks: orderedBlocks,
    rootBlocks: rootFragments.map(({ blocks: rootBlocks }) => rootBlocks),
  });
  blocks.clear();
  orderedBlocks.length = 0;
  const livenessStartedAt = startCompilerPerfPhase();
  const { liveIn, liveOut } = computeBlockLiveness(compacted.blocks, accesses);
  markCompilerPerfPhaseDuration(
    "borrowing.facts.symbolLiveness",
    livenessStartedAt,
  );
  return {
    entryBlock: compacted.blockForOriginal.get(entry.id)!,
    exitBlock: compacted.blockForOriginal.get(functionExit.id)!,
    roots: rootFragments.map(
      ({ expression, fragment, blocks: rootBlocks }) => ({
        expression,
        entryBlock: compacted.blockForOriginal.get(fragment.entry)!,
        blocks: Array.from(
          new Set(
            rootBlocks.map((block) => compacted.blockForOriginal.get(block)!),
          ),
        ),
      }),
    ),
    blocks: compacted.blocks,
    blockForExpression: new Map(
      Array.from(blockForExpression, ([expression, block]) => [
        expression,
        compacted.blockForOriginal.get(block)!,
      ]),
    ),
    evaluationOrder,
    controlForExpression,
    loopHeaderForExpression: new Map(
      Array.from(loopHeaderForExpression, ([expression, block]) => [
        expression,
        compacted.blockForOriginal.get(block)!,
      ]),
    ),
    bindingsAfterExpression,
    matchBindingsBeforeExpression,
    operations: compacted.blocks.flatMap((block) => block.operations),
    liveIn,
    liveOut,
  };
};

const compactCallableFlowBlocks = ({
  blocks,
  rootBlocks,
}: {
  blocks: readonly {
    id: number;
    expression?: HirExprId;
    operations: readonly CallableBorrowOperation[];
    predecessors: ReadonlySet<number>;
    successors: ReadonlySet<number>;
  }[];
  rootBlocks: readonly (readonly number[])[];
}): {
  blocks: readonly CallableBorrowFactBlock[];
  blockForOriginal: ReadonlyMap<number, number>;
} => {
  const rootForBlock = new Map<number, number>();
  rootBlocks.forEach((members, root) =>
    members.forEach((block) => rootForBlock.set(block, root)),
  );
  const canJoin = (left: number, right: number): boolean => {
    const leftBlock = blocks[left];
    const rightBlock = blocks[right];
    return (
      leftBlock?.successors.size === 1 &&
      rightBlock?.predecessors.size === 1 &&
      rootForBlock.get(left) === rootForBlock.get(right)
    );
  };
  const blockForOriginal = new Map<number, number>();
  const groups: number[][] = [];
  blocks.forEach((block) => {
    if (blockForOriginal.has(block.id)) return;
    const predecessor = Array.from(block.predecessors)[0];
    if (
      predecessor !== undefined &&
      canJoin(predecessor, block.id) &&
      !blockForOriginal.has(predecessor)
    ) {
      return;
    }
    const group: number[] = [];
    let current: number | undefined = block.id;
    while (current !== undefined && !blockForOriginal.has(current)) {
      group.push(current);
      blockForOriginal.set(current, groups.length);
      const successor: number | undefined = Array.from(
        blocks[current]!.successors,
      )[0];
      current =
        successor !== undefined && canJoin(current, successor)
          ? successor
          : undefined;
    }
    groups.push(group);
  });
  // Cyclic components always contain a join or branch in valid callable CFGs,
  // but keep the representation total if a future lowering creates a closed
  // single-successor cycle.
  blocks.forEach((block) => {
    if (blockForOriginal.has(block.id)) return;
    blockForOriginal.set(block.id, groups.length);
    groups.push([block.id]);
  });
  const compacted = groups.map((group, id): CallableBorrowFactBlock => {
    const members = new Set(group);
    const predecessors = new Set<number>();
    const successors = new Set<number>();
    group.forEach((original) => {
      blocks[original]!.predecessors.forEach((predecessor) => {
        if (!members.has(predecessor))
          predecessors.add(blockForOriginal.get(predecessor)!);
      });
      blocks[original]!.successors.forEach((successor) => {
        if (!members.has(successor))
          successors.add(blockForOriginal.get(successor)!);
      });
    });
    return {
      id,
      expressions: group.flatMap((original) => {
        const expression = blocks[original]!.expression;
        return expression === undefined ? [] : [expression];
      }),
      operations: group.flatMap((original) => blocks[original]!.operations),
      predecessors: Array.from(predecessors).sort((a, b) => a - b),
      successors: Array.from(successors).sort((a, b) => a - b),
    };
  });
  return { blocks: compacted, blockForOriginal };
};

const reachableFactBlocks = (
  entryBlock: number,
  blocks: readonly CallableBorrowFactBlock[],
): ReadonlySet<number> => {
  const reachable = new Set<number>();
  const pending = [entryBlock];
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (reachable.has(block)) continue;
    reachable.add(block);
    blocks[block]?.successors.forEach((successor) => pending.push(successor));
  }
  return reachable;
};

const computeExpressionValueLiveness = (
  blocks: readonly CallableBorrowFactBlock[],
  expressions: ReadonlyMap<HirExprId, HirExpression>,
  matchBindingsBeforeExpression: CallableBorrowFacts["matchBindingsBeforeExpression"],
): CallableBorrowFacts["expressionValueLiveness"] => {
  const inputs = (expression: HirExpression): readonly HirExprId[] => {
    switch (expression.exprKind) {
      case "field-access":
        return [expression.target];
      case "tuple":
        return expression.elements;
      case "object-literal":
        return expression.entries.map((entry) => entry.value);
      case "call":
        return [
          expression.callee,
          ...expression.args.map((argument) => argument.expr),
        ];
      case "method-call":
        return [
          expression.target,
          ...expression.args.map((argument) => argument.expr),
        ];
      case "assign":
        return [expression.value];
      case "block":
        return typeof expression.value === "number" ? [expression.value] : [];
      case "if":
      case "cond":
        return [
          ...expression.branches.map((branch) => branch.value),
          ...(typeof expression.defaultBranch === "number"
            ? [expression.defaultBranch]
            : []),
        ];
      case "match":
        return expression.arms.map((arm) => arm.value);
      case "effect-handler":
        return [
          expression.body,
          ...expression.handlers.map((handler) => handler.body),
        ];
      case "loop":
        return [expression.body];
      case "break":
        return typeof expression.value === "number" ? [expression.value] : [];
      case "literal":
      case "identifier":
      case "overload-set":
      case "lambda":
      case "while":
      case "continue":
        return [];
    }
  };
  const liveIn = new Map<number, Set<HirExprId>>(
    blocks.map((block) => [block.id, new Set()]),
  );
  const liveOut = new Map<number, Set<HirExprId>>(
    blocks.map((block) => [block.id, new Set()]),
  );
  const pending = [...blocks].reverse().map((block) => block.id);
  const queued = new Set(pending);
  while (pending.length > 0) {
    const blockId = pending.pop()!;
    queued.delete(blockId);
    const block = blocks[blockId]!;
    const nextOut = new Set(
      block.successors.flatMap((successor) =>
        Array.from(liveIn.get(successor) ?? []),
      ),
    );
    const nextIn = block.expressions.reduceRight((current, expressionId) => {
      const expression = expressions.get(expressionId);
      return new Set([
        ...(matchBindingsBeforeExpression.get(expressionId) ?? []).map(
          (binding) => binding.value,
        ),
        ...(expression ? inputs(expression) : []),
        ...Array.from(current).filter((value) => value !== expressionId),
      ]);
    }, nextOut);
    const priorIn = liveIn.get(block.id)!;
    const priorOut = liveOut.get(block.id)!;
    const changed =
      priorIn.size !== nextIn.size ||
      Array.from(nextIn).some((value) => !priorIn.has(value)) ||
      priorOut.size !== nextOut.size ||
      Array.from(nextOut).some((value) => !priorOut.has(value));
    if (!changed) continue;
    liveIn.set(block.id, nextIn);
    liveOut.set(block.id, nextOut);
    block.predecessors.forEach((predecessor) => {
      if (!queued.has(predecessor)) {
        queued.add(predecessor);
        pending.push(predecessor);
      }
    });
  }
  const byExpression = new Map<
    HirExprId,
    { liveInBlocks: number[]; liveOutBlocks: number[] }
  >();
  const record = (
    values: ReadonlyMap<number, ReadonlySet<HirExprId>>,
    key: "liveInBlocks" | "liveOutBlocks",
  ) =>
    values.forEach((expressionsInBlock, block) =>
      expressionsInBlock.forEach((expression) => {
        const liveness = byExpression.get(expression) ?? {
          liveInBlocks: [],
          liveOutBlocks: [],
        };
        liveness[key].push(block);
        byExpression.set(expression, liveness);
      }),
    );
  record(liveIn, "liveInBlocks");
  record(liveOut, "liveOutBlocks");
  return byExpression;
};

const computeBlockLiveness = (
  blocks: readonly {
    id: number;
    operations: readonly CallableBorrowOperation[];
    predecessors: readonly number[];
    successors: readonly number[];
  }[],
  accesses: readonly CallableBorrowAccessFact[],
): {
  liveIn: ReadonlyMap<SymbolId, readonly number[]>;
  liveOut: ReadonlyMap<SymbolId, readonly number[]>;
} => {
  const rootForPlace = new Map(
    accesses.flatMap((access) =>
      access.placeId === undefined || access.place === undefined
        ? []
        : ([[access.placeId, access.place.root]] as const),
    ),
  );
  const uses = new Map<number, Set<SymbolId>>();
  const definitions = new Map<number, Set<SymbolId>>();
  blocks.forEach((block) => {
    const blockUses = new Set<SymbolId>();
    const blockDefinitions = new Set<SymbolId>();
    block.operations.forEach((operation) => {
      if (operation.kind === "define") {
        blockDefinitions.add(operation.symbol);
      } else if (operation.kind === "use" || operation.kind === "capture") {
        if (!blockDefinitions.has(operation.symbol)) {
          blockUses.add(operation.symbol);
        }
      } else if (
        operation.kind === "read" ||
        operation.kind === "write" ||
        operation.kind === "move" ||
        operation.kind === "borrow" ||
        operation.kind === "call-argument"
      ) {
        if (
          operation.kind === "read" &&
          operation.accessRole === "assignment-target"
        ) {
          return;
        }
        const root =
          operation.placeId === undefined
            ? undefined
            : rootForPlace.get(operation.placeId);
        if (root !== undefined && !blockDefinitions.has(root)) {
          blockUses.add(root);
        }
      }
    });
    uses.set(block.id, blockUses);
    definitions.set(block.id, blockDefinitions);
  });
  const liveInByBlock = new Map<number, Set<SymbolId>>(
    blocks.map((block) => [block.id, new Set()]),
  );
  const liveOutByBlock = new Map<number, Set<SymbolId>>(
    blocks.map((block) => [block.id, new Set()]),
  );
  const pending = [...blocks].reverse().map((block) => block.id);
  const queued = new Set(pending);
  while (pending.length > 0) {
    const blockId = pending.pop()!;
    queued.delete(blockId);
    const block = blocks[blockId]!;
    const nextOut = new Set(
      block.successors.flatMap((successor) =>
        Array.from(liveInByBlock.get(successor) ?? []),
      ),
    );
    const nextIn = new Set([
      ...(uses.get(block.id) ?? []),
      ...Array.from(nextOut).filter(
        (symbol) => !definitions.get(block.id)?.has(symbol),
      ),
    ]);
    const priorIn = liveInByBlock.get(block.id)!;
    const priorOut = liveOutByBlock.get(block.id)!;
    const changed =
      priorIn.size !== nextIn.size ||
      Array.from(nextIn).some((symbol) => !priorIn.has(symbol)) ||
      priorOut.size !== nextOut.size ||
      Array.from(nextOut).some((symbol) => !priorOut.has(symbol));
    if (!changed) continue;
    liveInByBlock.set(block.id, nextIn);
    liveOutByBlock.set(block.id, nextOut);
    block.predecessors.forEach((predecessor) => {
      if (!queued.has(predecessor)) {
        queued.add(predecessor);
        pending.push(predecessor);
      }
    });
  }
  const invert = (
    byBlock: ReadonlyMap<number, ReadonlySet<SymbolId>>,
  ): ReadonlyMap<SymbolId, readonly number[]> => {
    const bySymbol = new Map<SymbolId, number[]>();
    byBlock.forEach((symbols, block) =>
      symbols.forEach((symbol) =>
        bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), block]),
      ),
    );
    return bySymbol;
  };
  return {
    liveIn: invert(liveInByBlock),
    liveOut: invert(liveOutByBlock),
  };
};

const symbolsInFactPattern = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(symbolsInFactPattern);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) =>
          symbolsInFactPattern(field.pattern),
        ),
        ...(pattern.spread ? symbolsInFactPattern(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? symbolsInFactPattern(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const transferTargetsInPattern = (
  pattern: HirPattern,
  projections: readonly PlaceProjection[] = [],
): readonly CallableBorrowTransferTarget[] => {
  switch (pattern.kind) {
    case "identifier":
      return [{ symbol: pattern.symbol, projections }];
    case "tuple":
      return pattern.elements.flatMap((element, index) =>
        transferTargetsInPattern(element, [
          ...projections,
          { kind: "tuple", index },
        ]),
      );
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) =>
          transferTargetsInPattern(field.pattern, [
            ...projections,
            { kind: "field", name: field.name },
          ]),
        ),
        ...(pattern.spread
          ? transferTargetsInPattern(pattern.spread, projections)
          : []),
      ];
    case "type":
      return pattern.binding
        ? transferTargetsInPattern(pattern.binding, projections)
        : [];
    case "wildcard":
      return [];
  }
};

const hashBorrowFactInput = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${serialized.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Captures every process-local type/effect input that borrowing transfer
 * follows transitively. Arena IDs alone are insufficient because nominal
 * object fields and effect rows live in side tables and can change while a
 * callable continues to address the same IDs.
 */
const typeFingerprintCache = new WeakMap<TypingResult, Map<TypeId, string>>();

const borrowingTypeFingerprint = ({
  roots,
  effectRows,
  typing,
}: {
  roots: readonly TypeId[];
  effectRows: readonly EffectRowId[];
  typing: TypingResult;
}): {
  types: readonly [TypeId, string][];
  effects: readonly [EffectRowId, unknown][];
} => {
  const cache = typeFingerprintCache.get(typing) ?? new Map<TypeId, string>();
  typeFingerprintCache.set(typing, cache);
  const fingerprintType = (
    type: TypeId,
    active = new Set<TypeId>(),
  ): string => {
    const cached = cache.get(type);
    if (cached) return cached;
    if (active.has(type)) return `cycle:${type}`;
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    const object =
      descriptor.kind === "nominal-object" || descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(type)
        : undefined;
    const constraint =
      descriptor.kind === "type-param-ref"
        ? typing.typeParameterConstraints.get(descriptor.param)
        : undefined;
    const children = (() => {
      switch (descriptor.kind) {
        case "borrowed":
          return [descriptor.inner];
        case "recursive":
          return [descriptor.body];
        case "trait":
        case "nominal-object":
        case "value-object":
          return [
            ...descriptor.typeArgs,
            ...(object?.fields.map((field) => field.type) ?? []),
          ];
        case "structural-object":
          return descriptor.fields.map((field) => field.type);
        case "function":
          return [
            ...descriptor.parameters.map((parameter) => parameter.type),
            descriptor.returnType,
          ];
        case "union":
          return descriptor.members;
        case "intersection":
          return [
            descriptor.nominal,
            descriptor.structural,
            ...(descriptor.traits ?? []),
          ].filter((member): member is TypeId => typeof member === "number");
        case "fixed-array":
          return [descriptor.element];
        case "type-param-ref":
          return constraint === undefined ? [] : [constraint];
        case "primitive":
          return [];
      }
    })();
    const fingerprint = hashBorrowFactInput({
      descriptor,
      ...(object
        ? {
            object: {
              objectKind: object.objectKind,
              baseNominal: object.baseNominal,
              fields: object.fields.map((field) => [
                field.name,
                field.optional,
                fingerprintType(field.type, nextActive),
              ]),
            },
          }
        : {}),
      ...(constraint === undefined
        ? {}
        : { constraint: fingerprintType(constraint, nextActive) }),
      children: children.map((child) => [
        child,
        fingerprintType(child, nextActive),
      ]),
      ...(descriptor.kind === "function"
        ? { effect: typing.effects.getRow(descriptor.effectRow) }
        : {}),
    });
    cache.set(type, fingerprint);
    return fingerprint;
  };
  return {
    types: Array.from(new Set(roots))
      .sort((left, right) => left - right)
      .map((type) => [type, fingerprintType(type)]),
    effects: Array.from(new Set(effectRows))
      .sort((left, right) => left - right)
      .map((row) => [row, typing.effects.getRow(row)]),
  };
};
const targetMaySuspend = (
  target: SymbolRef,
  resolveContext: ResolveContext,
): boolean => {
  if (target.moduleId !== resolveContext.moduleId) {
    const dependency = resolveContext.dependencies.get(target.moduleId);
    return (
      dependency?.effectOperations.get(target.symbol)?.maySuspend === true ||
      dependency?.callables.get(target.symbol)?.contract?.maySuspend === true
    );
  }
  const signature = resolveContext.typing.functions.getSignature(target.symbol);
  return (
    resolveContext.contracts.get(target.symbol)?.maySuspend === true ||
    (signature !== undefined &&
      !resolveContext.typing.effects.isEmpty(signature.effectRow))
  );
};
