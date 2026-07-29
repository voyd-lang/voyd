import type { SymbolTable } from "../binder/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import {
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirModuleLet,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, HirItemId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import {
  analyzeFunctionBorrowing,
  analyzeLambdaBodyBorrowing,
} from "./body-analysis.js";
import type {
  BorrowingResult,
  CallableBorrowContract,
  PlaceProjection,
} from "./model.js";
import { translateProjectionPath } from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import { computeCallableBorrowContracts } from "./summaries.js";
import {
  expressionTypeFor,
  projectedTypes,
  resolveBorrowCall,
  type ResolvedBorrowCall,
  type ResolveContext,
} from "./call-resolution.js";
import { typeCanCarryReference } from "./reference-bearing.js";
import { borrowedPathsInType, typeContainsBorrowed } from "./borrowed-types.js";
import { expressionCanFallThrough } from "./control-flow.js";
import { objectLiteralFieldProvider } from "./object-literal-providers.js";
import { validateNamedBorrowContracts } from "./named-contracts.js";

export const analyzeBorrowing = ({
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
}): BorrowingResult => {
  const summariesStartedAt = startCompilerPerfPhase();
  const summaryHir = hirWithTraitDefaultFunctions(hir);
  const inferredCallables = computeCallableBorrowContracts({
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
  });
  const callables = annotateBorrowedResultPresence({
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    callables: inferredCallables,
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.computeContracts",
    summariesStartedAt,
  );
  const mutableStorageSymbols = new Set<SymbolId>();
  const diagnostics: BorrowingResult["diagnostics"][number][] = [];
  const namedContracts = validateNamedBorrowContracts({
    hir,
    typing,
    symbolTable,
    callables,
  });
  diagnostics.push(...namedContracts.diagnostics);
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const resolveContext: ResolveContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    contracts: callables,
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    decls,
  };
  validateModuleBorrowStorage({
    hir,
    typing,
    symbolTable,
    resolveContext,
    diagnostics,
  });
  const selectionStartedAt = startCompilerPerfPhase();
  const functions = Array.from(hir.items.values())
    .filter((item): item is HirFunction => item.kind === "function")
    .filter((functionItem) =>
      bodyNeedsBorrowAnalysis({
        body: functionItem,
        hir,
        typing,
        resolveContext,
      }),
    );
  const lambdas = Array.from(hir.expressions.values()).filter(
    (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
  );
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.selectBodies",
    selectionStartedAt,
  );
  const bodiesStartedAt = startCompilerPerfPhase();
  functions.forEach((functionItem) =>
    analyzeFunctionBorrowing({
      functionItem,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      decls,
      contracts: callables,
      mutableStorageSymbols,
      diagnostics,
    }),
  );
  lambdas.forEach((lambda) =>
    analyzeLambdaBodyBorrowing({
      lambda,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      decls,
      contracts: callables,
      mutableStorageSymbols,
      diagnostics,
    }),
  );
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.checkBodies",
    bodiesStartedAt,
  );
  return {
    callables,
    namedContracts: namedContracts.contracts,
    mutableStorageSymbols,
    diagnostics,
  };
};

const hirWithTraitDefaultFunctions = (hir: HirGraph): HirGraph => {
  const existingSymbols = new Set(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [item.symbol] : [],
    ),
  );
  const defaultMethods = Array.from(hir.items.values()).flatMap((item) =>
    item.kind === "trait"
      ? item.methods.flatMap((method) =>
          typeof method.defaultBody === "number" &&
          !existingSymbols.has(method.symbol)
            ? [{ trait: item, method }]
            : [],
        )
      : [],
  );
  if (defaultMethods.length === 0) {
    return hir;
  }

  const items = new Map(hir.items);
  defaultMethods.forEach(({ trait, method }, index) => {
    const id = (-1 - index) as HirItemId;
    items.set(id, {
      kind: "function",
      id,
      ast: method.returnType?.ast ?? trait.ast,
      span: method.span,
      visibility: trait.visibility,
      symbol: method.symbol,
      typeParameters: method.typeParameters,
      parameters: method.parameters.map((parameter) => ({
        symbol: parameter.symbol,
        pattern: {
          kind: "identifier",
          symbol: parameter.symbol,
          bindingKind: parameter.bindingKind,
          span: parameter.span,
        },
        span: parameter.span,
        label: parameter.label,
        mutable: parameter.mutable,
        type: parameter.type,
      })),
      returnType: method.returnType,
      effectType: method.effectType,
      body: method.defaultBody!,
      borrowContract: method.borrowContract,
    });
  });
  return { ...hir, items };
};

type BorrowedResultPresence = "none" | "parameter" | "external";

const symbolsInPattern = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(symbolsInPattern);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => symbolsInPattern(field.pattern)),
        ...(pattern.spread ? symbolsInPattern(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? symbolsInPattern(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const combineBorrowedResultPresence = (
  values: readonly BorrowedResultPresence[],
): BorrowedResultPresence =>
  values.includes("external")
    ? "external"
    : values.includes("parameter")
      ? "parameter"
      : "none";

const createBorrowedResultPresenceAnalyzer = ({
  hir,
  typing,
  resolveContext,
  recursiveSeed = new Map(),
}: {
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
  recursiveSeed?: ReadonlyMap<SymbolId, BorrowedResultPresence>;
}): {
  expression: (
    exprId: HirExprId,
    parameterSymbols?: ReadonlySet<SymbolId>,
    activeFunctions?: ReadonlySet<SymbolId>,
  ) => BorrowedResultPresence;
  projection: (
    exprId: HirExprId,
    path: readonly PlaceProjection[],
    parameterSymbols?: ReadonlySet<SymbolId>,
    activeFunctions?: ReadonlySet<SymbolId>,
  ) => BorrowedResultPresence;
  function: (functionItem: HirFunction) => BorrowedResultPresence;
} => {
  const functionsBySymbol = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [[item.symbol, item] as const] : [],
    ),
  );
  const placeOfExpressionForPresence = (
    exprId: HirExprId,
    seen: ReadonlySet<HirExprId> = new Set(),
  ):
    | { root: SymbolId; projections: readonly PlaceProjection[] }
    | undefined => {
    if (seen.has(exprId)) {
      return undefined;
    }
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return undefined;
    }
    if (expression.exprKind === "identifier") {
      return { root: expression.symbol, projections: [] };
    }
    if (expression.exprKind === "field-access") {
      const target = placeOfExpressionForPresence(
        expression.target,
        new Set(seen).add(exprId),
      );
      if (!target) {
        return undefined;
      }
      const projection = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return {
        root: target.root,
        projections: [...target.projections, projection],
      };
    }
    if (expression.exprKind !== "call") {
      return undefined;
    }
    const callee = hir.expressions.get(expression.callee);
    if (callee?.exprKind !== "identifier") {
      return undefined;
    }
    const record = resolveContext.symbolTable.getSymbol(callee.symbol);
    const metadata = record.metadata as
      | { intrinsic?: boolean; intrinsicName?: string }
      | undefined;
    if (
      metadata?.intrinsic !== true ||
      (metadata.intrinsicName ?? record.name) !== "~"
    ) {
      return undefined;
    }
    const argument = expression.args[0]?.expr;
    return typeof argument === "number"
      ? placeOfExpressionForPresence(argument, new Set(seen).add(exprId))
      : undefined;
  };
  const rootSymbolOfExpression = (exprId: HirExprId): SymbolId | undefined =>
    placeOfExpressionForPresence(exprId)?.root;
  const writtenArgumentPlaces = (
    expression: HirExpression,
  ): readonly {
    root: SymbolId;
    projections: readonly PlaceProjection[];
  }[] => {
    if (
      expression.exprKind !== "call" &&
      expression.exprKind !== "method-call"
    ) {
      return [];
    }
    const resolved = resolveBorrowCall(expression, resolveContext);
    const places = (resolved.contract?.parameters ?? []).flatMap(
      (parameter, index) => {
        const argument = resolved.arguments[index];
        if (typeof argument !== "number") {
          return [];
        }
        const place = placeOfExpressionForPresence(argument);
        if (!place) {
          return [];
        }
        const paths = [
          ...(parameter.writePaths ?? []),
          ...(parameter.invalidatedPaths ?? []),
        ];
        return paths.map((path) => ({
          root: place.root,
          projections: [
            ...place.projections,
            ...path.filter(
              (projection) =>
                projection.kind !== "dereference" &&
                projection.kind !== "identity",
            ),
          ],
        }));
      },
    );
    return Array.from(
      new Map(
        places.map((place) => [
          JSON.stringify([place.root, place.projections]),
          place,
        ]),
      ).values(),
    );
  };
  const reassignedSymbols = new Set<SymbolId>();
  hir.expressions.forEach((expression) => {
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      writtenArgumentPlaces(expression).forEach(({ root }) =>
        reassignedSymbols.add(root),
      );
    }
    if (expression.exprKind !== "assign") {
      return;
    }
    if (typeof expression.target === "number") {
      const root = rootSymbolOfExpression(expression.target);
      if (typeof root === "number") {
        reassignedSymbols.add(root);
      }
    }
    if (expression.pattern) {
      symbolsInPattern(expression.pattern).forEach((symbol) =>
        reassignedSymbols.add(symbol),
      );
    }
  });
  const stableLocalInitializers = new Map<
    SymbolId,
    { value: HirExprId; path: readonly PlaceProjection[] }
  >();
  const bindStableInitializer = (
    pattern: HirPattern,
    value: HirExprId,
    path: readonly PlaceProjection[] = [],
  ): void => {
    if (pattern.kind === "identifier") {
      if (!reassignedSymbols.has(pattern.symbol)) {
        stableLocalInitializers.set(pattern.symbol, { value, path });
      }
      return;
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach((element, index) =>
        bindStableInitializer(element, value, [
          ...path,
          { kind: "tuple", index },
        ]),
      );
      return;
    }
    if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) =>
        bindStableInitializer(field.pattern, value, [
          ...path,
          { kind: "field", name: field.name },
        ]),
      );
      if (pattern.spread) {
        bindStableInitializer(pattern.spread, value, path);
      }
      return;
    }
    if (pattern.kind === "type" && pattern.binding) {
      bindStableInitializer(pattern.binding, value, path);
    }
  };
  hir.statements.forEach((statement) => {
    if (statement.kind !== "let") {
      return;
    }
    bindStableInitializer(statement.pattern, statement.initializer);
  });
  type ProjectedInitializer = {
    value: HirExprId;
    path: readonly PlaceProjection[];
    updates?: readonly {
      target: readonly PlaceProjection[];
      value?: HirExprId;
      source?: readonly PlaceProjection[];
    }[];
  };
  type InitializerEnvironment = Map<SymbolId, readonly ProjectedInitializer[]>;
  const reachingInitializers = new Map<
    HirExprId,
    readonly ProjectedInitializer[]
  >();
  const uniqueInitializers = (
    values: readonly ProjectedInitializer[],
  ): readonly ProjectedInitializer[] =>
    Array.from(
      new Map(
        values.map((value) => [
          JSON.stringify([value.value, value.path, value.updates ?? []]),
          value,
        ]),
      ).values(),
    );
  const projectionsEqual = (
    left: PlaceProjection,
    right: PlaceProjection,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);
  const projectionPathIsPrefix = (
    prefix: readonly PlaceProjection[],
    path: readonly PlaceProjection[],
  ): boolean =>
    prefix.length <= path.length &&
    prefix.every((projection, index) =>
      projectionsEqual(projection, path[index]!),
    );
  const withInitializerUpdate = (
    initializer: ProjectedInitializer,
    update: NonNullable<ProjectedInitializer["updates"]>[number],
  ): ProjectedInitializer => ({
    ...initializer,
    updates: [
      ...(initializer.updates ?? []).filter(
        (existing) =>
          !projectionPathIsPrefix(existing.target, update.target) &&
          !projectionPathIsPrefix(update.target, existing.target),
      ),
      update,
    ],
  });
  const updateEnvironmentPlace = ({
    environment,
    root,
    target,
    value,
  }: {
    environment: InitializerEnvironment;
    root: SymbolId;
    target: readonly PlaceProjection[];
    value?: HirExprId;
  }): void => {
    const definitions = environment.get(root);
    if (!definitions) {
      environment.delete(root);
      return;
    }
    environment.set(
      root,
      definitions.map((initializer) =>
        withInitializerUpdate(initializer, {
          target,
          ...(typeof value === "number" ? { value, source: [] } : {}),
        }),
      ),
    );
  };
  const locationsForEnvironmentSymbol = (
    symbol: SymbolId,
    environment: InitializerEnvironment,
    seen: ReadonlySet<SymbolId> = new Set(),
  ): readonly {
    root: SymbolId;
    prefix: readonly PlaceProjection[];
  }[] => {
    if (seen.has(symbol)) {
      return [{ root: symbol, prefix: [] }];
    }
    const definitions = environment.get(symbol);
    if (!definitions) {
      return [{ root: symbol, prefix: [] }];
    }
    const locations = definitions.flatMap((initializer) => {
      const place = placeOfExpressionForPresence(initializer.value);
      if (!place) {
        return [{ root: symbol, prefix: [] }];
      }
      return locationsForEnvironmentSymbol(
        place.root,
        environment,
        new Set(seen).add(symbol),
      ).map((location) => ({
        root: location.root,
        prefix: [...location.prefix, ...place.projections, ...initializer.path],
      }));
    });
    return Array.from(
      new Map(
        locations.map((location) => [
          JSON.stringify([location.root, location.prefix]),
          location,
        ]),
      ).values(),
    );
  };
  const updateEnvironmentAliases = ({
    environment,
    root,
    target,
    value,
  }: {
    environment: InitializerEnvironment;
    root: SymbolId;
    target: readonly PlaceProjection[];
    value?: HirExprId;
  }): void => {
    const canonicalTargets = locationsForEnvironmentSymbol(
      root,
      environment,
    ).map((location) => ({
      root: location.root,
      path: [...location.prefix, ...target],
    }));
    Array.from(environment.keys()).forEach((symbol) => {
      const relativeTargets = locationsForEnvironmentSymbol(
        symbol,
        environment,
      ).flatMap((location) =>
        canonicalTargets.flatMap((canonical) => {
          if (location.root !== canonical.root) {
            return [];
          }
          if (projectionPathIsPrefix(location.prefix, canonical.path)) {
            return [canonical.path.slice(location.prefix.length)];
          }
          return projectionPathIsPrefix(canonical.path, location.prefix)
            ? [[]]
            : [];
        }),
      );
      relativeTargets.forEach((relativeTarget) =>
        updateEnvironmentPlace({
          environment,
          root: symbol,
          target: relativeTarget,
          value,
        }),
      );
    });
  };
  const bindEnvironmentPattern = (
    pattern: HirPattern,
    value: HirExprId,
    environment: InitializerEnvironment,
    path: readonly PlaceProjection[] = [],
  ): void => {
    if (pattern.kind === "identifier") {
      environment.set(pattern.symbol, [{ value, path }]);
      return;
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach((element, index) =>
        bindEnvironmentPattern(element, value, environment, [
          ...path,
          { kind: "tuple", index },
        ]),
      );
      return;
    }
    if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) =>
        bindEnvironmentPattern(field.pattern, value, environment, [
          ...path,
          { kind: "field", name: field.name },
        ]),
      );
      if (pattern.spread) {
        bindEnvironmentPattern(pattern.spread, value, environment, path);
      }
      return;
    }
    if (pattern.kind === "type" && pattern.binding) {
      bindEnvironmentPattern(pattern.binding, value, environment, path);
    }
  };
  const mergeEnvironments = (
    environments: readonly InitializerEnvironment[],
  ): InitializerEnvironment => {
    const first = environments[0];
    if (!first) {
      return new Map();
    }
    const result = new Map<SymbolId, readonly ProjectedInitializer[]>();
    first.forEach((_definitions, symbol) => {
      if (!environments.every((environment) => environment.has(symbol))) {
        return;
      }
      result.set(
        symbol,
        uniqueInitializers(
          environments.flatMap((environment) => environment.get(symbol) ?? []),
        ),
      );
    });
    return result;
  };
  const cloneEnvironment = (
    environment: InitializerEnvironment,
  ): InitializerEnvironment =>
    new Map(
      Array.from(environment, ([symbol, definitions]) => [
        symbol,
        [...definitions],
      ]),
    );
  const environmentKey = (environment: InitializerEnvironment): string =>
    JSON.stringify(
      Array.from(environment, ([symbol, definitions]) => [
        symbol,
        definitions.map((definition) => [
          definition.value,
          definition.path,
          definition.updates ?? [],
        ]),
      ]).sort(([left], [right]) => Number(left) - Number(right)),
    );
  const loopBreakEnvironments: InitializerEnvironment[][] = [];
  const loopContinueEnvironments: InitializerEnvironment[][] = [];
  const observedEnvironmentCollectors: InitializerEnvironment[][] = [];
  const analyzeExpressionInitializers = (
    exprId: HirExprId,
    environment: InitializerEnvironment,
  ): readonly InitializerEnvironment[] => {
    observedEnvironmentCollectors.at(-1)?.push(cloneEnvironment(environment));
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return [environment];
    }
    const analyzeSequence = (
      children: readonly HirExprId[],
      initial: readonly InitializerEnvironment[],
    ): readonly InitializerEnvironment[] =>
      children.reduce<readonly InitializerEnvironment[]>(
        (environments, child) =>
          environments.flatMap((candidate) =>
            analyzeExpressionInitializers(child, candidate),
          ),
        initial,
      );
    switch (expression.exprKind) {
      case "literal":
      case "overload-set":
        return [environment];
      case "continue":
        loopContinueEnvironments.at(-1)?.push(cloneEnvironment(environment));
        return [];
      case "identifier": {
        const definitions = environment.get(expression.symbol);
        if (definitions) {
          reachingInitializers.set(
            expression.id,
            uniqueInitializers([
              ...(reachingInitializers.get(expression.id) ?? []),
              ...definitions,
            ]),
          );
        }
        return [environment];
      }
      case "lambda":
        return [environment];
      case "field-access":
        return analyzeExpressionInitializers(expression.target, environment);
      case "tuple":
        return analyzeSequence(expression.elements, [environment]);
      case "object-literal":
        return analyzeSequence(
          expression.entries.map((entry) => entry.value),
          [environment],
        );
      case "call": {
        const evaluated = analyzeSequence(
          [
            expression.callee,
            ...expression.args.map((argument) => argument.expr),
          ],
          [environment],
        );
        const writtenPlaces = writtenArgumentPlaces(expression);
        return evaluated.map((next) => {
          writtenPlaces.forEach(({ root, projections }) =>
            updateEnvironmentAliases({
              environment: next,
              root,
              target: projections,
            }),
          );
          return next;
        });
      }
      case "method-call": {
        const evaluated = analyzeSequence(
          [
            expression.target,
            ...expression.args.map((argument) => argument.expr),
          ],
          [environment],
        );
        const writtenPlaces = writtenArgumentPlaces(expression);
        return evaluated.map((next) => {
          writtenPlaces.forEach(({ root, projections }) =>
            updateEnvironmentAliases({
              environment: next,
              root,
              target: projections,
            }),
          );
          return next;
        });
      }
      case "block": {
        let environments: readonly InitializerEnvironment[] = [environment];
        for (const statementId of expression.statements) {
          const statement = hir.statements.get(statementId);
          if (!statement || environments.length === 0) {
            continue;
          }
          if (statement.kind === "return") {
            if (typeof statement.value === "number") {
              environments.forEach((candidate) =>
                analyzeExpressionInitializers(statement.value!, candidate),
              );
            }
            environments = [];
            break;
          }
          if (statement.kind === "let") {
            environments = environments.flatMap((candidate) =>
              analyzeExpressionInitializers(
                statement.initializer,
                candidate,
              ).map((next) => {
                bindEnvironmentPattern(
                  statement.pattern,
                  statement.initializer,
                  next,
                );
                return next;
              }),
            );
            continue;
          }
          environments = environments.flatMap((candidate) =>
            analyzeExpressionInitializers(statement.expr, candidate),
          );
        }
        return typeof expression.value === "number"
          ? analyzeSequence([expression.value], environments)
          : environments;
      }
      case "assign": {
        const evaluated = analyzeSequence(
          [
            ...(typeof expression.target === "number"
              ? [expression.target]
              : []),
            expression.value,
          ],
          [environment],
        );
        return evaluated.map((next) => {
          if (typeof expression.target === "number") {
            const target = hir.expressions.get(expression.target);
            if (target?.exprKind === "identifier") {
              next.set(target.symbol, [{ value: expression.value, path: [] }]);
            } else {
              const place = placeOfExpressionForPresence(expression.target);
              if (place) {
                updateEnvironmentAliases({
                  environment: next,
                  root: place.root,
                  target: place.projections,
                  value: expression.value,
                });
              }
            }
          }
          if (expression.pattern) {
            bindEnvironmentPattern(expression.pattern, expression.value, next);
          }
          return next;
        });
      }
      case "if":
      case "cond": {
        let pending: readonly InitializerEnvironment[] = [environment];
        const branches: InitializerEnvironment[] = [];
        expression.branches.forEach((branch) => {
          const conditioned = pending.flatMap((candidate) =>
            analyzeExpressionInitializers(branch.condition, candidate),
          );
          branches.push(
            ...conditioned.flatMap((candidate) =>
              analyzeExpressionInitializers(
                branch.value,
                cloneEnvironment(candidate),
              ),
            ),
          );
          pending = conditioned;
        });
        const defaults =
          typeof expression.defaultBranch === "number"
            ? pending.flatMap((candidate) =>
                analyzeExpressionInitializers(
                  expression.defaultBranch!,
                  cloneEnvironment(candidate),
                ),
              )
            : pending.map(cloneEnvironment);
        const merged = mergeEnvironments([...branches, ...defaults]);
        return [merged];
      }
      case "match": {
        const discriminants = analyzeExpressionInitializers(
          expression.discriminant,
          environment,
        );
        const arms = discriminants.flatMap((candidate) =>
          expression.arms.flatMap((arm) => {
            const armEnvironment = cloneEnvironment(candidate);
            bindEnvironmentPattern(
              arm.pattern,
              expression.discriminant,
              armEnvironment,
            );
            const guarded =
              typeof arm.guard === "number"
                ? analyzeExpressionInitializers(arm.guard, armEnvironment)
                : [armEnvironment];
            return guarded.flatMap((next) =>
              analyzeExpressionInitializers(arm.value, next),
            );
          }),
        );
        return [mergeEnvironments(arms)];
      }
      case "effect-handler": {
        const observed: InitializerEnvironment[] = [];
        observedEnvironmentCollectors.push(observed);
        const body = analyzeExpressionInitializers(
          expression.body,
          cloneEnvironment(environment),
        );
        observedEnvironmentCollectors.pop();
        const handlerEntry = mergeEnvironments([
          cloneEnvironment(environment),
          ...observed,
          ...body,
        ]);
        const handlers = expression.handlers.flatMap((handler) =>
          analyzeExpressionInitializers(
            handler.body,
            cloneEnvironment(handlerEntry),
          ),
        );
        const merged = mergeEnvironments([...body, ...handlers]);
        return typeof expression.finallyBranch === "number"
          ? analyzeExpressionInitializers(expression.finallyBranch, merged)
          : [merged];
      }
      case "loop": {
        let head = cloneEnvironment(environment);
        const exits: InitializerEnvironment[] = [];
        while (true) {
          const breaks: InitializerEnvironment[] = [];
          const continues: InitializerEnvironment[] = [];
          loopBreakEnvironments.push(breaks);
          loopContinueEnvironments.push(continues);
          const backedges = analyzeExpressionInitializers(
            expression.body,
            cloneEnvironment(head),
          );
          loopBreakEnvironments.pop();
          loopContinueEnvironments.pop();
          exits.push(...breaks);
          const next = mergeEnvironments([head, ...backedges, ...continues]);
          if (environmentKey(next) === environmentKey(head)) {
            break;
          }
          head = next;
        }
        return exits.length > 0 ? [mergeEnvironments(exits)] : [];
      }
      case "while": {
        let head = cloneEnvironment(environment);
        const exits: InitializerEnvironment[] = [];
        while (true) {
          const conditioned = analyzeExpressionInitializers(
            expression.condition,
            cloneEnvironment(head),
          );
          exits.push(...conditioned);
          const breaks: InitializerEnvironment[] = [];
          const continues: InitializerEnvironment[] = [];
          loopBreakEnvironments.push(breaks);
          loopContinueEnvironments.push(continues);
          const backedges = conditioned.flatMap((candidate) =>
            analyzeExpressionInitializers(
              expression.body,
              cloneEnvironment(candidate),
            ),
          );
          loopBreakEnvironments.pop();
          loopContinueEnvironments.pop();
          exits.push(...breaks);
          const next = mergeEnvironments([head, ...backedges, ...continues]);
          if (environmentKey(next) === environmentKey(head)) {
            break;
          }
          head = next;
        }
        return [mergeEnvironments(exits)];
      }
      case "break":
        (typeof expression.value === "number"
          ? analyzeExpressionInitializers(expression.value, environment)
          : [environment]
        ).forEach((candidate) =>
          loopBreakEnvironments.at(-1)?.push(cloneEnvironment(candidate)),
        );
        return [];
    }
  };
  hir.items.forEach((item) => {
    if (item.kind === "function") {
      analyzeExpressionInitializers(item.body, new Map());
    } else if (item.kind === "module-let") {
      analyzeExpressionInitializers(item.initializer, new Map());
    }
  });
  const functionPresence = new Map<SymbolId, BorrowedResultPresence>();
  type ParameterSubstitution = ProjectedInitializer & {
    parameterSymbols: ReadonlySet<SymbolId>;
    activeFunctions: ReadonlySet<SymbolId>;
  };
  const parameterSubstitutions: Map<SymbolId, ParameterSubstitution>[] = [];
  const parameterSubstitutionFor = (
    symbol: SymbolId,
  ): ParameterSubstitution | undefined => {
    for (
      let index = parameterSubstitutions.length - 1;
      index >= 0;
      index -= 1
    ) {
      const substitution = parameterSubstitutions[index]?.get(symbol);
      if (substitution) {
        return substitution;
      }
    }
    return undefined;
  };

  function presenceOfResolvedArgument({
    resolved,
    parameter,
    path,
    parameterSymbols,
    activeFunctions,
    seenExpressions,
    borrowedContext,
    seenParameters = new Set(),
  }: {
    resolved: ResolvedBorrowCall;
    parameter: number;
    path: readonly PlaceProjection[];
    parameterSymbols: ReadonlySet<SymbolId>;
    activeFunctions: ReadonlySet<SymbolId>;
    seenExpressions: ReadonlySet<HirExprId>;
    borrowedContext: boolean;
    seenParameters?: ReadonlySet<number>;
  }): BorrowedResultPresence {
    const argument = resolved.arguments[parameter];
    if (typeof argument === "number") {
      return presenceOfProjection(
        argument,
        path,
        parameterSymbols,
        activeFunctions,
        seenExpressions,
        borrowedContext,
      );
    }
    const contract = resolved.contract?.parameters[parameter];
    if (
      contract?.defaultBorrowedResult === "none" ||
      contract?.defaultNoBorrowPaths?.some((noBorrowPath) =>
        projectionPathIsPrefix(noBorrowPath, path),
      )
    ) {
      return "none";
    }
    if (seenParameters.has(parameter)) {
      return "external";
    }
    const nextSeenParameters = new Set(seenParameters).add(parameter);
    const origins = (contract?.defaultOrigins ?? []).flatMap((origin) => {
      const translated = translateProjectionPath({
        result: origin.result,
        source: origin.source,
        requested: path,
      });
      return translated
        ? [
            presenceOfResolvedArgument({
              resolved,
              parameter: origin.parameter,
              path: translated,
              parameterSymbols,
              activeFunctions,
              seenExpressions,
              borrowedContext,
              seenParameters: nextSeenParameters,
            }),
          ]
        : [];
    });
    return origins.length > 0
      ? combineBorrowedResultPresence(origins)
      : "external";
  }

  function presenceOfInitializerProjection({
    symbol,
    initializer,
    requested,
    parameterSymbols,
    activeFunctions,
    seenExpressions,
    borrowedContext,
  }: {
    symbol: SymbolId;
    initializer: ProjectedInitializer;
    requested: readonly PlaceProjection[];
    parameterSymbols: ReadonlySet<SymbolId>;
    activeFunctions: ReadonlySet<SymbolId>;
    seenExpressions: ReadonlySet<HirExprId>;
    borrowedContext: boolean;
  }): BorrowedResultPresence {
    const rootType = typing.valueTypes.get(symbol);
    const pathContainsBorrowed = (path: readonly PlaceProjection[]): boolean =>
      typeof rootType === "number" &&
      projectedTypes(rootType, path, typing).some((projected) =>
        typeContainsBorrowed(projected, typing),
      );
    const contextualBorrow = borrowedContext || pathContainsBorrowed(requested);
    const ancestor = initializer.updates?.find((update) =>
      projectionPathIsPrefix(update.target, requested),
    );
    if (ancestor) {
      if (typeof ancestor.value !== "number") {
        return contextualBorrow ? "external" : "none";
      }
      return presenceOfProjection(
        ancestor.value,
        [
          ...(ancestor.source ?? []),
          ...requested.slice(ancestor.target.length),
        ],
        parameterSymbols,
        activeFunctions,
        seenExpressions,
        contextualBorrow,
      );
    }
    const borrowedPaths =
      typeof rootType === "number" ? borrowedPathsInType(rootType, typing) : [];
    const borrowedDescendants = borrowedPaths.filter(
      (path) =>
        path.length > requested.length &&
        projectionPathIsPrefix(requested, path),
    );
    const borrowsRequestedValue = borrowedPaths.some(
      (path) =>
        path.length === requested.length &&
        projectionPathIsPrefix(requested, path),
    );
    if (borrowedDescendants.length > 0 && !borrowsRequestedValue) {
      return combineBorrowedResultPresence(
        borrowedDescendants.map((path) =>
          presenceOfInitializerProjection({
            symbol,
            initializer,
            requested: path,
            parameterSymbols,
            activeFunctions,
            seenExpressions,
            borrowedContext,
          }),
        ),
      );
    }
    const base = presenceOfProjection(
      initializer.value,
      [...initializer.path, ...requested],
      parameterSymbols,
      activeFunctions,
      seenExpressions,
      contextualBorrow,
    );
    const descendants = (initializer.updates ?? []).filter((update) =>
      projectionPathIsPrefix(requested, update.target),
    );
    if (descendants.length === 0) {
      return base;
    }
    return combineBorrowedResultPresence([
      base,
      ...descendants.map((update) => {
        const updateContext =
          contextualBorrow || pathContainsBorrowed(update.target);
        return typeof update.value === "number"
          ? presenceOfProjection(
              update.value,
              update.source ?? [],
              parameterSymbols,
              activeFunctions,
              seenExpressions,
              updateContext,
            )
          : updateContext
            ? "external"
            : "none";
      }),
    ]);
  }

  const collectReachableReturnValues = (
    exprId: HirExprId,
    values: HirExprId[],
  ): void => {
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return;
    }
    const visit = (child: HirExprId): boolean => {
      collectReachableReturnValues(child, values);
      return expressionCanFallThrough(child, hir);
    };
    switch (expression.exprKind) {
      case "literal":
      case "identifier":
      case "overload-set":
      case "continue":
      case "lambda":
        return;
      case "block": {
        for (const statementId of expression.statements) {
          const statement = hir.statements.get(statementId);
          if (!statement) {
            continue;
          }
          if (statement.kind === "return") {
            if (typeof statement.value === "number") {
              values.push(statement.value);
            }
            return;
          }
          const child =
            statement.kind === "let" ? statement.initializer : statement.expr;
          if (!visit(child)) {
            return;
          }
        }
        if (typeof expression.value === "number") {
          visit(expression.value);
        }
        return;
      }
      case "call":
        if (!visit(expression.callee)) {
          return;
        }
        for (const argument of expression.args) {
          if (!visit(argument.expr)) {
            return;
          }
        }
        return;
      case "method-call":
        if (!visit(expression.target)) {
          return;
        }
        for (const argument of expression.args) {
          if (!visit(argument.expr)) {
            return;
          }
        }
        return;
      case "tuple":
        for (const element of expression.elements) {
          if (!visit(element)) {
            return;
          }
        }
        return;
      case "object-literal":
        for (const entry of expression.entries) {
          if (!visit(entry.value)) {
            return;
          }
        }
        return;
      case "field-access":
        visit(expression.target);
        return;
      case "assign":
        if (
          typeof expression.target === "number" &&
          !visit(expression.target)
        ) {
          return;
        }
        visit(expression.value);
        return;
      case "if":
      case "cond":
        expression.branches.forEach((branch) => {
          visit(branch.condition);
          visit(branch.value);
        });
        if (typeof expression.defaultBranch === "number") {
          visit(expression.defaultBranch);
        }
        return;
      case "match":
        if (!visit(expression.discriminant)) {
          return;
        }
        expression.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            visit(arm.guard);
          }
          visit(arm.value);
        });
        return;
      case "loop":
        visit(expression.body);
        return;
      case "while":
        if (visit(expression.condition)) {
          visit(expression.body);
        }
        return;
      case "effect-handler":
        visit(expression.body);
        expression.handlers.forEach((handler) => visit(handler.body));
        if (typeof expression.finallyBranch === "number") {
          visit(expression.finallyBranch);
        }
        return;
      case "break":
        if (typeof expression.value === "number") {
          visit(expression.value);
        }
        return;
    }
  };

  const presenceOfExpression = (
    exprId: HirExprId,
    parameterSymbols: ReadonlySet<SymbolId> = new Set(),
    activeFunctions: ReadonlySet<SymbolId> = new Set(),
    seenExpressions: ReadonlySet<HirExprId> = new Set(),
    borrowedContext = false,
  ): BorrowedResultPresence => {
    if (seenExpressions.has(exprId)) {
      return "external";
    }
    const type = typing.resolvedExprTypes.get(exprId);
    if (
      !borrowedContext &&
      typeof type === "number" &&
      !typeContainsBorrowed(type, typing) &&
      !typing.arena.containsTypeParams(type)
    ) {
      return "none";
    }
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return "external";
    }
    const nextSeen = new Set(seenExpressions).add(exprId);
    switch (expression.exprKind) {
      case "literal":
        return borrowedContext ? "external" : "none";
      case "overload-set":
      case "continue":
        return "none";
      case "lambda":
        return borrowedContext ? "external" : "none";
      case "identifier": {
        const substituted = parameterSubstitutionFor(expression.symbol);
        if (substituted) {
          return presenceOfProjection(
            substituted.value,
            substituted.path,
            substituted.parameterSymbols,
            substituted.activeFunctions,
            nextSeen,
            borrowedContext,
          );
        }
        const reaching = reachingInitializers.get(expression.id);
        if (reaching) {
          return combineBorrowedResultPresence(
            reaching.map((initializer) =>
              presenceOfInitializerProjection({
                symbol: expression.symbol,
                initializer,
                requested: [],
                parameterSymbols,
                activeFunctions,
                seenExpressions: nextSeen,
                borrowedContext,
              }),
            ),
          );
        }
        const initializer = stableLocalInitializers.get(expression.symbol);
        if (initializer) {
          return presenceOfInitializerProjection({
            symbol: expression.symbol,
            initializer,
            requested: [],
            parameterSymbols,
            activeFunctions,
            seenExpressions: nextSeen,
            borrowedContext,
          });
        }
        return parameterSymbols.has(expression.symbol)
          ? "parameter"
          : "external";
      }
      case "tuple":
        if (
          borrowedContext &&
          typeof type === "number" &&
          !typeContainsBorrowed(type, typing)
        ) {
          return "external";
        }
        return combineBorrowedResultPresence(
          expression.elements.map((element, index) =>
            presenceOfExpression(
              element,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              typeof type === "number" &&
                projectedTypes(type, [{ kind: "tuple", index }], typing).some(
                  (projected) => typeContainsBorrowed(projected, typing),
                ),
            ),
          ),
        );
      case "object-literal":
        if (expression.entries.length === 0) {
          return "none";
        }
        if (
          borrowedContext &&
          typeof type === "number" &&
          !typeContainsBorrowed(type, typing)
        ) {
          return "external";
        }
        if (typeof type === "number") {
          const borrowedPaths = borrowedPathsInType(type, typing);
          if (borrowedPaths.length > 0) {
            return combineBorrowedResultPresence(
              borrowedPaths.map((path) =>
                presenceOfProjection(
                  expression.id,
                  path,
                  parameterSymbols,
                  activeFunctions,
                  seenExpressions,
                  true,
                ),
              ),
            );
          }
        }
        return combineBorrowedResultPresence(
          expression.entries.map((entry) =>
            presenceOfExpression(
              entry.value,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              typeof type === "number" &&
                projectedTypes(
                  type,
                  entry.kind === "field"
                    ? [{ kind: "field", name: entry.name }]
                    : [],
                  typing,
                ).some((projected) => typeContainsBorrowed(projected, typing)),
            ),
          ),
        );
      case "field-access":
        return presenceOfProjection(
          expression.target,
          [
            Number.isInteger(Number(expression.field))
              ? { kind: "tuple", index: Number(expression.field) }
              : { kind: "field", name: expression.field },
          ],
          parameterSymbols,
          activeFunctions,
          nextSeen,
          borrowedContext ||
            (typeof type === "number" &&
              typing.arena.get(typing.arena.unfoldRecursive(type)).kind ===
                "borrowed"),
        );
      case "block":
        return typeof expression.value === "number"
          ? presenceOfExpression(
              expression.value,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              borrowedContext,
            )
          : "none";
      case "if":
      case "cond":
        return combineBorrowedResultPresence([
          ...expression.branches.map((branch) =>
            presenceOfExpression(
              branch.value,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              borrowedContext,
            ),
          ),
          ...(typeof expression.defaultBranch === "number"
            ? [
                presenceOfExpression(
                  expression.defaultBranch,
                  parameterSymbols,
                  activeFunctions,
                  nextSeen,
                  borrowedContext,
                ),
              ]
            : []),
        ]);
      case "match":
        return combineBorrowedResultPresence(
          expression.arms.map((arm) =>
            presenceOfExpression(
              arm.value,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              borrowedContext,
            ),
          ),
        );
      case "effect-handler":
        return combineBorrowedResultPresence([
          presenceOfExpression(
            expression.body,
            parameterSymbols,
            activeFunctions,
            nextSeen,
            borrowedContext,
          ),
          ...expression.handlers.map((handler) =>
            presenceOfExpression(
              handler.body,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              borrowedContext,
            ),
          ),
        ]);
      case "call":
      case "method-call": {
        const resolved = resolveBorrowCall(expression, resolveContext);
        if (resolved.targets.length === 0) {
          return "external";
        }
        if (
          resolved.targets.every(
            (target) => target.moduleId === resolveContext.moduleId,
          )
        ) {
          return combineBorrowedResultPresence(
            resolved.targets.map((target) => {
              const targetFunction = functionsBySymbol.get(target.symbol);
              if (!targetFunction) {
                return "external";
              }
              return activeFunctions.has(target.symbol)
                ? (recursiveSeed.get(target.symbol) ?? "none")
                : presenceOfFunctionAtCall({
                    functionItem: targetFunction,
                    arguments: resolved.arguments,
                    callerParameterSymbols: parameterSymbols,
                    activeFunctions: new Set(activeFunctions).add(
                      target.symbol,
                    ),
                    borrowedContext,
                  });
            }),
          );
        }
        const targetPresence = resolved.targets.map((target) => {
          if (target.moduleId !== resolveContext.moduleId) {
            return (
              resolveContext.dependencies
                .get(target.moduleId)
                ?.callables.get(target.symbol)?.contract?.borrowedResult ??
              "external"
            );
          }
          const targetFunction = functionsBySymbol.get(target.symbol);
          if (!targetFunction) {
            return "external";
          }
          if (activeFunctions.has(target.symbol)) {
            return recursiveSeed.get(target.symbol) ?? "none";
          }
          return presenceOfFunction(
            targetFunction,
            new Set(activeFunctions).add(target.symbol),
          );
        });
        const combinedTargetPresence =
          combineBorrowedResultPresence(targetPresence);
        if (combinedTargetPresence === "external") {
          return combinedTargetPresence;
        }
        if (combinedTargetPresence === "none" && !borrowedContext) {
          return "none";
        }
        const returnedInputs =
          resolved.contract?.parameters.flatMap((parameter, index) =>
            (parameter.returnedOrigins ?? []).map((origin) => ({
              parameter: index,
              source: origin.source,
              borrowedContext:
                borrowedContext ||
                parameter.returnedSharedOrigins?.some(
                  (shared) => JSON.stringify(shared) === JSON.stringify(origin),
                ) === true,
            })),
          ) ?? [];
        if (returnedInputs.length === 0) {
          return "external";
        }
        return combineBorrowedResultPresence(
          returnedInputs.map(({ parameter, source, borrowedContext }) => {
            return presenceOfResolvedArgument({
              resolved,
              parameter,
              path: source,
              parameterSymbols,
              activeFunctions,
              seenExpressions: nextSeen,
              borrowedContext,
            });
          }),
        );
      }
      case "assign":
        return presenceOfExpression(
          expression.value,
          parameterSymbols,
          activeFunctions,
          nextSeen,
          borrowedContext,
        );
      case "break":
        return typeof expression.value === "number"
          ? presenceOfExpression(
              expression.value,
              parameterSymbols,
              activeFunctions,
              nextSeen,
              borrowedContext,
            )
          : "none";
      case "loop":
      case "while":
        return "none";
    }
  };

  const presenceOfProjection = (
    exprId: HirExprId,
    path: readonly PlaceProjection[],
    parameterSymbols: ReadonlySet<SymbolId>,
    activeFunctions: ReadonlySet<SymbolId>,
    seenExpressions: ReadonlySet<HirExprId>,
    borrowedContext = false,
  ): BorrowedResultPresence => {
    if (path.length === 0) {
      return presenceOfExpression(
        exprId,
        parameterSymbols,
        activeFunctions,
        seenExpressions,
        borrowedContext,
      );
    }
    if (seenExpressions.has(exprId)) {
      return "external";
    }
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return "external";
    }
    const nextSeen = new Set(seenExpressions).add(exprId);
    if (expression.exprKind === "identifier") {
      const substituted = parameterSubstitutionFor(expression.symbol);
      if (substituted) {
        return presenceOfProjection(
          substituted.value,
          [...substituted.path, ...path],
          substituted.parameterSymbols,
          substituted.activeFunctions,
          nextSeen,
          borrowedContext,
        );
      }
      const reaching = reachingInitializers.get(expression.id);
      if (reaching) {
        return combineBorrowedResultPresence(
          reaching.map((initializer) =>
            presenceOfInitializerProjection({
              symbol: expression.symbol,
              initializer,
              requested: path,
              parameterSymbols,
              activeFunctions,
              seenExpressions: nextSeen,
              borrowedContext,
            }),
          ),
        );
      }
      const initializer = stableLocalInitializers.get(expression.symbol);
      if (!initializer) {
        return parameterSymbols.has(expression.symbol)
          ? "parameter"
          : "external";
      }
      return presenceOfInitializerProjection({
        symbol: expression.symbol,
        initializer,
        requested: path,
        parameterSymbols,
        activeFunctions,
        seenExpressions: nextSeen,
        borrowedContext,
      });
    }
    const [projection, ...remaining] = path;
    if (expression.exprKind === "tuple" && projection?.kind === "tuple") {
      const element = expression.elements[projection.index];
      return typeof element === "number"
        ? presenceOfProjection(
            element,
            remaining,
            parameterSymbols,
            activeFunctions,
            nextSeen,
            borrowedContext,
          )
        : "external";
    }
    if (
      expression.exprKind === "object-literal" &&
      projection?.kind === "field"
    ) {
      const provider = objectLiteralFieldProvider({
        expression,
        field: projection.name,
        spreadProvidesField: (value) => {
          const spreadType = typing.resolvedExprTypes.get(value);
          return (
            typeof spreadType === "number" &&
            projectedTypes(spreadType, [projection], typing).length > 0
          );
        },
      });
      return provider
        ? presenceOfProjection(
            provider.value,
            provider.kind === "spread" ? path : remaining,
            parameterSymbols,
            activeFunctions,
            nextSeen,
            borrowedContext,
          )
        : "none";
    }
    if (expression.exprKind === "field-access") {
      const selected = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return presenceOfProjection(
        expression.target,
        [selected, ...path],
        parameterSymbols,
        activeFunctions,
        nextSeen,
        borrowedContext,
      );
    }
    if (
      expression.exprKind === "block" &&
      typeof expression.value === "number"
    ) {
      return presenceOfProjection(
        expression.value,
        path,
        parameterSymbols,
        activeFunctions,
        nextSeen,
        borrowedContext,
      );
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      return combineBorrowedResultPresence([
        ...expression.branches.map((branch) =>
          presenceOfProjection(
            branch.value,
            path,
            parameterSymbols,
            activeFunctions,
            nextSeen,
            borrowedContext,
          ),
        ),
        ...(typeof expression.defaultBranch === "number"
          ? [
              presenceOfProjection(
                expression.defaultBranch,
                path,
                parameterSymbols,
                activeFunctions,
                nextSeen,
                borrowedContext,
              ),
            ]
          : []),
      ]);
    }
    if (expression.exprKind === "match") {
      return combineBorrowedResultPresence(
        expression.arms.map((arm) =>
          presenceOfProjection(
            arm.value,
            path,
            parameterSymbols,
            activeFunctions,
            nextSeen,
            borrowedContext,
          ),
        ),
      );
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const resolved = resolveBorrowCall(expression, resolveContext);
      if (resolved.targets.length === 0) {
        return "external";
      }
      if (
        resolved.targets.every(
          (target) => target.moduleId === resolveContext.moduleId,
        )
      ) {
        return combineBorrowedResultPresence(
          resolved.targets.map((target) => {
            const targetFunction = functionsBySymbol.get(target.symbol);
            if (!targetFunction) {
              return "external";
            }
            return activeFunctions.has(target.symbol)
              ? (recursiveSeed.get(target.symbol) ?? "none")
              : presenceOfFunctionAtCall({
                  functionItem: targetFunction,
                  arguments: resolved.arguments,
                  callerParameterSymbols: parameterSymbols,
                  activeFunctions: new Set(activeFunctions).add(target.symbol),
                  resultPath: path,
                  borrowedContext,
                });
          }),
        );
      }
      const targetPresence = combineBorrowedResultPresence(
        resolved.targets.map((target) => {
          if (target.moduleId !== resolveContext.moduleId) {
            return (
              resolveContext.dependencies
                .get(target.moduleId)
                ?.callables.get(target.symbol)?.contract?.borrowedResult ??
              "external"
            );
          }
          const targetFunction = functionsBySymbol.get(target.symbol);
          if (!targetFunction) {
            return "external";
          }
          if (activeFunctions.has(target.symbol)) {
            return recursiveSeed.get(target.symbol) ?? "none";
          }
          return presenceOfFunction(
            targetFunction,
            new Set(activeFunctions).add(target.symbol),
          );
        }),
      );
      if (targetPresence === "external") {
        return targetPresence;
      }
      if (targetPresence === "none" && !borrowedContext) {
        return "none";
      }
      const returnedInputs =
        resolved.contract?.parameters.flatMap((parameter, index) =>
          (parameter.returnedOrigins ?? []).flatMap((origin) => {
            const translated = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: path,
            });
            return translated
              ? [
                  {
                    parameter: index,
                    source: translated,
                    borrowedContext:
                      borrowedContext ||
                      parameter.returnedSharedOrigins?.some(
                        (shared) =>
                          JSON.stringify(shared) === JSON.stringify(origin),
                      ) === true,
                  },
                ]
              : [];
          }),
        ) ?? [];
      if (returnedInputs.length === 0) {
        return borrowedContext ? "external" : "none";
      }
      return combineBorrowedResultPresence(
        returnedInputs.map(({ parameter, source, borrowedContext }) => {
          return presenceOfResolvedArgument({
            resolved,
            parameter,
            path: source,
            parameterSymbols,
            activeFunctions,
            seenExpressions: nextSeen,
            borrowedContext,
          });
        }),
      );
    }
    return presenceOfExpression(
      exprId,
      parameterSymbols,
      activeFunctions,
      seenExpressions,
      borrowedContext,
    );
  };

  const returnedValuesForFunction = (
    functionItem: HirFunction,
  ): readonly HirExprId[] => {
    const returnedValues: HirExprId[] = [];
    collectReachableReturnValues(functionItem.body, returnedValues);
    const body = hir.expressions.get(functionItem.body);
    if (
      body?.exprKind === "block" &&
      typeof body.value === "number" &&
      expressionCanFallThrough(functionItem.body, hir)
    ) {
      returnedValues.push(body.value);
    } else if (body?.exprKind !== "block") {
      returnedValues.push(functionItem.body);
    }
    return returnedValues;
  };

  const presenceOfFunctionAtCall = ({
    functionItem,
    arguments: arguments_,
    callerParameterSymbols,
    activeFunctions,
    resultPath = [],
    borrowedContext = false,
  }: {
    functionItem: HirFunction;
    arguments: readonly (HirExprId | undefined)[];
    callerParameterSymbols: ReadonlySet<SymbolId>;
    activeFunctions: ReadonlySet<SymbolId>;
    resultPath?: readonly PlaceProjection[];
    borrowedContext?: boolean;
  }): BorrowedResultPresence => {
    const substitutions = new Map<SymbolId, ParameterSubstitution>();
    const bind = (
      pattern: HirPattern,
      value: HirExprId,
      path: readonly PlaceProjection[] = [],
    ): void => {
      if (pattern.kind === "identifier") {
        substitutions.set(pattern.symbol, {
          value,
          path,
          parameterSymbols: callerParameterSymbols,
          activeFunctions,
        });
        return;
      }
      if (pattern.kind === "tuple") {
        pattern.elements.forEach((element, index) =>
          bind(element, value, [...path, { kind: "tuple", index }]),
        );
        return;
      }
      if (pattern.kind === "destructure") {
        pattern.fields.forEach((field) =>
          bind(field.pattern, value, [
            ...path,
            { kind: "field", name: field.name },
          ]),
        );
        if (pattern.spread) {
          bind(pattern.spread, value, path);
        }
        return;
      }
      if (pattern.kind === "type" && pattern.binding) {
        bind(pattern.binding, value, path);
      }
    };
    parameterSubstitutions.push(substitutions);
    functionItem.parameters.forEach((parameter, index) => {
      const argument = arguments_[index];
      const value =
        typeof argument === "number" ? argument : parameter.defaultValue;
      if (typeof value === "number") {
        bind(parameter.pattern, value);
      }
    });
    const parameterSymbols = new Set(
      functionItem.parameters.flatMap((parameter) =>
        symbolsInPattern(parameter.pattern),
      ),
    );
    const returnType = typing.functions.getSignature(
      functionItem.symbol,
    )?.returnType;
    const returnBorrowedContext =
      borrowedContext ||
      (typeof returnType === "number" &&
        projectedTypes(returnType, resultPath, typing).some((projected) =>
          typeContainsBorrowed(projected, typing),
        ));
    const presence = combineBorrowedResultPresence(
      returnedValuesForFunction(functionItem).map((value) =>
        resultPath.length > 0
          ? presenceOfProjection(
              value,
              resultPath,
              parameterSymbols,
              activeFunctions,
              new Set(),
              returnBorrowedContext,
            )
          : presenceOfExpression(
              value,
              parameterSymbols,
              activeFunctions,
              new Set(),
              returnBorrowedContext,
            ),
      ),
    );
    parameterSubstitutions.pop();
    return presence;
  };

  const presenceOfFunction = (
    functionItem: HirFunction,
    activeFunctions: ReadonlySet<SymbolId> = new Set([functionItem.symbol]),
  ): BorrowedResultPresence => {
    const cached = functionPresence.get(functionItem.symbol);
    if (cached) {
      return cached;
    }
    const returnType = typing.functions.getSignature(
      functionItem.symbol,
    )?.returnType;
    if (
      typeof returnType === "number" &&
      !typeContainsBorrowed(returnType, typing) &&
      !typing.arena.containsTypeParams(returnType)
    ) {
      functionPresence.set(functionItem.symbol, "none");
      return "none";
    }
    const parameterSymbols = new Set(
      functionItem.parameters.flatMap((parameter) =>
        symbolsInPattern(parameter.pattern),
      ),
    );
    const returnedValues = returnedValuesForFunction(functionItem);
    const presence = combineBorrowedResultPresence(
      returnedValues.map((value) =>
        presenceOfExpression(
          value,
          parameterSymbols,
          activeFunctions,
          new Set(),
          typeof returnType === "number" &&
            typeContainsBorrowed(returnType, typing),
        ),
      ),
    );
    functionPresence.set(functionItem.symbol, presence);
    return presence;
  };

  return {
    expression: presenceOfExpression,
    projection: (
      exprId,
      path,
      parameterSymbols = new Set(),
      activeFunctions = new Set(),
    ) =>
      presenceOfProjection(
        exprId,
        path,
        parameterSymbols,
        activeFunctions,
        new Set(),
      ),
    function: presenceOfFunction,
  };
};

const annotateBorrowedResultPresence = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  callables,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly { local: SymbolId; target?: SymbolRef }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
}): ReadonlyMap<SymbolId, CallableBorrowContract> => {
  const functions = Array.from(hir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  let presence = new Map<SymbolId, BorrowedResultPresence>(
    functions.map((item) => [item.symbol, "none"]),
  );
  for (
    let iteration = 0;
    iteration < Math.max(2, functions.length * 3);
    iteration += 1
  ) {
    const contracts = new Map(
      Array.from(callables, ([symbol, contract]) => [
        symbol,
        {
          ...contract,
          borrowedResult: presence.get(symbol) ?? contract.borrowedResult,
        },
      ]),
    );
    const resolveContext: ResolveContext = {
      hir,
      typing,
      symbolTable,
      moduleId,
      imports: new Map(
        imports.flatMap((entry) =>
          entry.target ? ([[entry.local, entry.target]] as const) : [],
        ),
      ),
      dependencies,
      contracts,
      bindingInitializers: new Map(),
      callResolutionCache: new Map(),
      decls,
    };
    const analyzer = createBorrowedResultPresenceAnalyzer({
      hir,
      typing,
      resolveContext,
      recursiveSeed: presence,
    });
    const next = new Map(
      functions.map((item) => [item.symbol, analyzer.function(item)]),
    );
    if (
      functions.every(
        (item) => presence.get(item.symbol) === next.get(item.symbol),
      )
    ) {
      presence = next;
      break;
    }
    presence = next;
  }
  const annotated = new Map(
    Array.from(callables, ([symbol, contract]) => [
      symbol,
      {
        ...contract,
        borrowedResult: presence.get(symbol) ?? contract.borrowedResult,
      },
    ]),
  );
  const resolveContext: ResolveContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: new Map(
      imports.flatMap((entry) =>
        entry.target ? ([[entry.local, entry.target]] as const) : [],
      ),
    ),
    dependencies,
    contracts: annotated,
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    decls,
  };
  const analyzer = createBorrowedResultPresenceAnalyzer({
    hir,
    typing,
    resolveContext,
    recursiveSeed: presence,
  });
  return new Map(
    Array.from(annotated, ([symbol, contract]) => {
      const functionItem = functions.find((item) => item.symbol === symbol);
      if (!functionItem) {
        return [symbol, contract] as const;
      }
      const priorParameterSymbols = new Set<SymbolId>();
      return [
        symbol,
        {
          ...contract,
          parameters: contract.parameters.map((parameterContract, index) => {
            const parameter = functionItem.parameters[index];
            const parameterType =
              typing.functions.getSignature(symbol)?.parameters[index]?.type;
            const defaultBorrowedResult =
              typeof parameter?.defaultValue === "number" &&
              analyzer.expression(
                parameter.defaultValue,
                priorParameterSymbols,
              ) === "none"
                ? ("none" as const)
                : undefined;
            const candidateDefaultPaths =
              typeof parameterType === "number"
                ? [
                    [],
                    ...borrowedPathsInType(parameterType, typing).flatMap(
                      (path) =>
                        path.map((_projection, pathIndex) =>
                          path.slice(0, pathIndex + 1),
                        ),
                    ),
                  ]
                : [[]];
            const defaultNoBorrowPaths =
              typeof parameter?.defaultValue === "number"
                ? Array.from(
                    new Map(
                      candidateDefaultPaths
                        .filter(
                          (path) =>
                            analyzer.projection(
                              parameter.defaultValue!,
                              path,
                              priorParameterSymbols,
                            ) === "none",
                        )
                        .map((path) => [JSON.stringify(path), path]),
                    ).values(),
                  )
                : [];
            if (parameter) {
              symbolsInPattern(parameter.pattern).forEach((parameterSymbol) =>
                priorParameterSymbols.add(parameterSymbol),
              );
            }
            return {
              ...parameterContract,
              ...(defaultBorrowedResult ? { defaultBorrowedResult } : {}),
              ...(defaultNoBorrowPaths.length > 0
                ? { defaultNoBorrowPaths }
                : {}),
            };
          }),
        },
      ] as const;
    }),
  );
};

const validateModuleBorrowStorage = ({
  hir,
  typing,
  symbolTable,
  resolveContext,
  diagnostics,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  resolveContext: ResolveContext;
  diagnostics: BorrowingResult["diagnostics"][number][];
}): void => {
  const presence = createBorrowedResultPresenceAnalyzer({
    hir,
    typing,
    resolveContext,
    recursiveSeed: new Map(
      Array.from(resolveContext.contracts, ([symbol, contract]) => [
        symbol,
        contract.borrowedResult ?? "external",
      ]),
    ),
  });

  Array.from(hir.items.values())
    .filter((item): item is HirModuleLet => item.kind === "module-let")
    .forEach((item) => {
      const storedType = typing.valueTypes.get(item.symbol);
      const initializerType = typing.resolvedExprTypes.get(item.initializer);
      const type = storedType ?? initializerType;
      const storedDescriptor =
        typeof storedType === "number"
          ? typing.arena.get(typing.arena.unfoldRecursive(storedType))
          : undefined;
      if (
        typeof type !== "number" ||
        !typeContainsBorrowed(type, typing) ||
        (storedDescriptor?.kind !== "borrowed" &&
          presence.expression(item.initializer) === "none")
      ) {
        return;
      }
      diagnostics.push(
        diagnosticFromCode({
          code: "TY0051",
          params: {
            kind: "explicit-borrow-escape",
            binding: symbolTable.getSymbol(item.symbol).name,
            through: "module storage",
          },
          span: item.span,
        }),
      );
    });
};

// A body without both reference state and a borrow-producing or mutating
// operation cannot form an alias conflict. Unknown types and calls remain on
// the full-analysis path.
const bodyNeedsBorrowAnalysis = ({
  body,
  hir,
  typing,
  resolveContext,
}: {
  body: HirFunction;
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): boolean => {
  const signature = typing.functions.getSignature(body.symbol);
  let hasBorrowOperation =
    body.parameters.some(
      (parameter) => parameter.pattern.bindingKind === "mutable-ref",
    ) ||
    (signature?.parameters.some((parameter) =>
      typeContainsBorrowed(parameter.type, typing),
    ) ??
      false) ||
    (typeof signature?.returnType === "number" &&
      typeContainsBorrowed(signature.returnType, typing));
  let hasReferenceState = hasBorrowOperation;
  walkExpression({
    exprId: body.body,
    hir,
    options: { skipLambdas: true },
    onEnterExpression: (exprId, expression) => {
      if (
        expression.exprKind === "lambda" &&
        expression.captures.some((capture) => capture.mutable)
      ) {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
      if (hasBorrowOperation && hasReferenceState) {
        return { stop: true };
      }
      if (expression.exprKind === "assign") {
        hasBorrowOperation ||= assignmentNeedsBorrowAnalysis(
          expression,
          resolveContext,
        );
      }
      const callAccess =
        expression.exprKind === "call" || expression.exprKind === "method-call"
          ? callBorrowAccess(expression, resolveContext)
          : undefined;
      if (callAccess?.access === "mutable") {
        hasBorrowOperation = true;
        hasReferenceState = true;
      }
      if (callAccess?.access === "shared" && callAccess.requiresAnalysis) {
        hasBorrowOperation = true;
        hasReferenceState ||= callAccess.formsExplicitBorrow;
      }
      if (
        expression.exprKind === "overload-set" ||
        isDeclaredCallableIdentifier(expression, typing)
      ) {
        return;
      }
      const typeId = expressionTypeFor(exprId, resolveContext);
      if (typeof typeId !== "number") {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
      if (
        typing.arena.get(typeId).kind === "function" ||
        !typeCanCarryReference(typeId, typing)
      ) {
        return;
      }
      hasBorrowOperation ||= typeContainsBorrowed(typeId, typing);
      hasReferenceState = true;
      if (hasBorrowOperation) {
        return { stop: true };
      }
    },
    onEnterPattern: (pattern) => {
      if (
        pattern.bindingKind !== undefined &&
        pattern.bindingKind !== "value"
      ) {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
    },
  });
  return hasBorrowOperation && hasReferenceState;
};

const assignmentNeedsBorrowAnalysis = (
  expression: Extract<HirExpression, { exprKind: "assign" }>,
  resolveContext: ResolveContext,
): boolean => {
  const canCarryReference = (exprId: number): boolean => {
    const typeId = expressionTypeFor(exprId, resolveContext);
    return (
      typeof typeId !== "number" ||
      typeCanCarryReference(typeId, resolveContext.typing)
    );
  };
  if (canCarryReference(expression.value)) {
    return true;
  }
  if (typeof expression.target !== "number") {
    return false;
  }
  let placeExprId = expression.target;
  while (true) {
    if (canCarryReference(placeExprId)) {
      return true;
    }
    const place = resolveContext.hir.expressions.get(placeExprId);
    if (place?.exprKind === "field-access") {
      placeExprId = place.target;
      continue;
    }
    return false;
  }
};

const callBorrowAccess = (
  expression: HirExpression,
  resolveContext: ResolveContext,
): {
  access: "mutable" | "shared" | "owned";
  requiresAnalysis: boolean;
  formsExplicitBorrow: boolean;
} => {
  const resolved = resolveBorrowCall(expression, resolveContext);
  const contract = resolved.contract;
  const parameters = contract?.parameters ?? [];
  const formsExplicitBorrow =
    resolved.signature?.parameters.some((parameter) =>
      typeContainsBorrowed(parameter.type, resolveContext.typing),
    ) ?? false;
  const requiresAnalysis =
    contract?.maySuspend === true ||
    (contract?.scopedCallbacks?.length ?? 0) > 0 ||
    parameters.some((parameter) => parameter.retained || parameter.returned) ||
    formsExplicitBorrow;
  if (parameters.some((parameter) => parameter.access === "mutable")) {
    return { access: "mutable", requiresAnalysis, formsExplicitBorrow };
  }
  return {
    access: parameters.some((parameter) => parameter.access === "shared")
      ? "shared"
      : "owned",
    requiresAnalysis,
    formsExplicitBorrow,
  };
};

const isDeclaredCallableIdentifier = (
  expression: HirExpression,
  typing: TypingResult,
): boolean =>
  expression.exprKind === "identifier" &&
  typing.functions.getSignature(expression.symbol) !== undefined;
