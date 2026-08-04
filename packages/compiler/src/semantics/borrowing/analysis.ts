import type { SymbolTable } from "../binder/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import {
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import {
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirModuleLet,
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
import {
  mergeCallableBorrowContracts,
  translateProjectionPath,
} from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import { computeCallableBorrowContracts } from "./summaries.js";
import {
  abstractTraitContractFromImplementation,
  projectedTypes,
  resolveBorrowCall,
  type ResolveContext,
} from "./call-resolution.js";
import {
  referenceOriginsInType,
  typeCanCarryReference,
} from "./reference-bearing.js";
import { borrowedPathsInType, typeContainsBorrowed } from "./borrowed-types.js";
import { objectLiteralFieldProvider } from "./object-literal-providers.js";
import {
  lowerNamedBorrowContracts,
  validateNamedBorrowContracts,
} from "./named-contracts.js";
import {
  createLazyCallableBorrowFacts,
  type CallableBorrowFacts,
} from "./callable-facts.js";
import {
  type ImportedCallableCapability,
} from "./capability-classifier.js";
import {
  extractCallableBorrowIndex,
  type CallableBorrowIndex,
} from "./callable-borrow-index.js";
import {
  checkTransientSameCallOverlaps,
  contractFromBorrowIndex,
} from "./transient-contract.js";
import { inferTransientBorrowingRouting } from "./contract-routing.js";
import { planTransientRuntimeIdentityGuards } from "./transient-guards.js";

export const analyzeBorrowing = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  checkBodies = true,
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
  checkBodies?: boolean;
}): BorrowingResult => {
  const summariesStartedAt = startCompilerPerfPhase();
  const summaryHir = hirWithTraitDefaultFunctions(hir);
  const effectOperationContracts = effectOperationCallableContracts({
    hir,
    typing,
    decls,
  });
  // Lower declared trait/region contracts before body inference. Declaration
  // validation does not need inferred body facts; seeding the single contract
  // solve here avoids analyzing every callable once to discover declarations
  // and then again with those declarations installed.
  const preliminaryNamedContracts = lowerNamedBorrowContracts({
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
  });
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const declaredContracts = new Map([
    ...effectOperationContracts,
    ...preliminaryNamedContracts.declarationCallables,
  ]);
  const functions = Array.from(summaryHir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  const lambdas = Array.from(hir.expressions.values()).filter(
    (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
  );
  const importedCallables = new Map<string, ImportedCallableCapability>();
  dependencies.forEach((dependency, dependencyModuleId) => {
    dependency.callables.forEach((callable, symbol) => {
      importedCallables.set(`${dependencyModuleId}:${symbol}`, {
        ...(callable.capability !== undefined
          ? { capability: callable.capability }
          : {}),
        ...(callable.contract ? { contract: callable.contract } : {}),
      });
    });
    dependency.effectOperations.forEach((_operation, symbol) => {
      const key = `${dependencyModuleId}:${symbol}`;
      if (importedCallables.has(key)) return;
      importedCallables.set(key, {
        // An effect operation without an exported capability is an ambiguous
        // boundary. Its compact contract is not available here, so keep the
        // unknown case on the conservative flow-sensitive path.
        capability: "flow-sensitive",
      });
    });
  });
  const localCallables = new Map<SymbolId, ImportedCallableCapability>();
  declaredContracts.forEach((contract, symbol) => {
    localCallables.set(symbol, { contract });
  });
  const indexResolveContext: ResolveContext = {
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    contracts: declaredContracts,
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    borrowIndexMode: "symbolic",
    decls,
  };
  const functionIndexes = extractCallableBorrowIndex({
    callables: functions,
    hir: summaryHir,
    typing,
    symbolTable,
    decls,
    resolveContext: indexResolveContext,
  });
  const lambdaIndexes = extractCallableBorrowIndex({
    callables: lambdas.map((lambda) => ({
      symbol: (-1 - lambda.id) as SymbolId,
      parameters: lambda.parameters,
      body: lambda.body,
      type: typing.resolvedExprTypes.get(lambda.id),
      captures: lambda.captures,
    })),
    hir: summaryHir,
    typing,
    symbolTable,
    decls,
    resolveContext: indexResolveContext,
  });
  const indexes = new Map<SymbolId, CallableBorrowIndex>([
    ...functionIndexes,
    ...lambdaIndexes,
  ]);
  const initialContracts = new Map<SymbolId, CallableBorrowContract>(
    Array.from(indexes, ([symbol, index]) => [
      symbol,
      contractFromBorrowIndex(index),
    ]),
  );
  effectOperationContracts.forEach((contract, symbol) =>
    initialContracts.set(symbol, contract),
  );
  declaredContracts.forEach((contract, symbol) => initialContracts.set(symbol, contract));
  // Flow-sensitive callables do not publish these seed contracts as their
  // final ABI. They provide only the cheap access/effect footprint needed to
  // classify an immediate caller use without treating the callee's maximum
  // mode as contagious.
  const initialCompactContracts = new Map<SymbolId, CallableBorrowContract>([
    ...initialContracts,
    ...effectOperationContracts,
    ...declaredContracts,
  ]);
  initialCompactContracts.forEach((contract, symbol) => {
    const prior = localCallables.get(symbol);
    localCallables.set(symbol, { ...prior, contract });
  });
  const compactStartedAt = startCompilerPerfPhase();
  const transientRouting = inferTransientBorrowingRouting({
    indexes,
    localModuleId: moduleId,
    declaredContracts,
    importedCallables,
    localCallables,
    initialContracts,
    initialCompactContracts,
  });
  const capabilities = new Map(transientRouting.capabilities);
  const contracts = new Map(transientRouting.contracts);
  const compactFallbacks = transientRouting.compactFallbacks;
  capabilities.forEach((mode) =>
    incrementCompilerPerfCounter(`borrowing.capability.${mode}`),
  );
  transientRouting.decisions.forEach((decision) =>
    decision.reasons.forEach((reason) =>
      incrementCompilerPerfCounter(`borrowing.capability.reason.${reason}`),
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.capability.compactFallbacks",
    compactFallbacks,
  );
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.composeCompactContracts",
    compactStartedAt,
  );
  const flowInitialContracts = new Map(contracts);
  indexes.forEach((index, symbol) => {
    if (capabilities.get(symbol) !== "flow-sensitive") return;
    flowInitialContracts.set(
      symbol,
      declaredContracts.get(symbol) ?? contractFromBorrowIndex(index),
    );
  });
  const flowFunctions = functions.filter(
    (functionItem) => capabilities.get(functionItem.symbol) === "flow-sensitive",
  );
  const flowLambdas = lambdas.filter(
    (lambda) => capabilities.get((-1 - lambda.id) as SymbolId) === "flow-sensitive",
  );
  const flowSymbols = new Set<SymbolId>([
    ...flowFunctions.map((functionItem) => functionItem.symbol),
    ...flowLambdas.map((lambda) => (-1 - lambda.id) as SymbolId),
  ]);
  const lazyFacts = createLazyCallableBorrowFacts({
    functions: flowFunctions,
    lambdas: flowLambdas,
    hir: summaryHir,
    typing,
    resolveContext: {
      ...indexResolveContext,
      contracts,
      callResolutionCache: new Map(),
    },
  });
  const callableFacts = lazyFacts.functions;
  const lambdaFacts = lazyFacts.lambdas;
  const nonFlowFactSymbols = [
    ...Array.from(callableFacts.keys()),
    ...Array.from(
      lambdaFacts.keys(),
      (exprId) => (-1 - exprId) as SymbolId,
    ),
  ].filter(
    (symbol) => capabilities.get(symbol) !== "flow-sensitive",
  );
  if (nonFlowFactSymbols.length > 0) {
    throw new Error(
      `borrowing architecture violation: full facts materialized for ${nonFlowFactSymbols.join(", ")}`,
    );
  }
  const inferStartedAt = startCompilerPerfPhase();
  const inferred = computeCallableBorrowContracts({
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    declarationContracts: declaredContracts,
    facts: callableFacts,
    lambdaFacts,
    initialContracts: flowInitialContracts,
    flowSymbols,
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.inferContracts",
    inferStartedAt,
  );
  incrementCompilerPerfCounter(
    "borrowing.fullFacts.materialized",
    lazyFacts.materializedCount(),
  );
  const allCallableFacts = new Map<SymbolId, CallableBorrowFacts>([
    ...Array.from(callableFacts.entries()),
    ...Array.from(
      lambdaFacts.values(),
      (facts) => [facts.symbol, facts] as const,
    ),
  ]);
  incrementCompilerPerfCounter(
    "borrowing.facts.blocks",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.blocks.length,
      0,
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.facts.operations",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.operations.length,
      0,
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.facts.suspensions",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.suspensionPoints.length,
      0,
    ),
  );
  const publicDynamicContract = ({
    contract,
    named,
    declarations,
  }: {
    contract: CallableBorrowContract;
    named: import("./model.js").CheckedNamedBorrowContract;
    declarations: ReadonlyMap<SymbolId, CallableBorrowContract>;
  }): CallableBorrowContract => {
    const implementation = abstractTraitContractFromImplementation({
      contract,
      named,
      privateFieldNames: new Set(),
    });
    const declaration = declarations.get(named.declaration);
    return declaration
      ? mergeCallableBorrowContracts([implementation, declaration])!
      : implementation;
  };
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.computeContracts",
    summariesStartedAt,
  );
  const mutableStorageSymbols = new Set<SymbolId>();
  const runtimeIdentityGuards = new Map<
    number,
    import("./model.js").RuntimeIdentityGuard[]
  >();
  const diagnostics: BorrowingResult["diagnostics"][number][] = [];
  const validationStartedAt = startCompilerPerfPhase();
  const namedContracts = validateNamedBorrowContracts({
    hir,
    typing,
    symbolTable,
    callables: inferred.contracts,
    moduleId,
    imports,
    validateBodies: checkBodies,
  });
  diagnostics.push(...namedContracts.diagnostics);
  const callables = new Map(inferred.contracts);
  namedContracts.declarationCallables.forEach((contract, symbol) => {
    callables.set(symbol, contract);
  });
  namedContracts.contracts.forEach((named, symbol) => {
    const contract = callables.get(symbol);
    if (named.implementation === undefined || !contract) {
      return;
    }
    callables.set(symbol, {
      ...contract,
      dynamicDispatch: publicDynamicContract({
        contract,
        named,
        declarations: namedContracts.declarationCallables,
      }),
    });
  });
  effectOperationContracts.forEach((contract, symbol) => {
    callables.set(symbol, contract);
  });
  const resolvedContracts = new Map(callables);
  inferred.lambdaContracts.forEach((contract, exprId) => {
    const facts = lambdaFacts.get(exprId);
    if (facts) resolvedContracts.set(facts.symbol, contract);
  });
  const lambdaContracts = new Map(
    lambdas.flatMap((lambda) => {
      const contract = resolvedContracts.get((-1 - lambda.id) as SymbolId);
      return contract ? [[lambda.id, contract] as const] : [];
    }),
  );
  indexes.forEach((index, symbol) => {
    if (capabilities.get(symbol) !== "transient") return;
    const transientGuardPlan = planTransientRuntimeIdentityGuards({
      index,
      typing,
      lookup: {
        localModuleId: moduleId,
        localCapabilities: capabilities,
        localContracts: resolvedContracts,
        importedCallables,
      },
    });
    transientGuardPlan.guards.forEach((guards, call) => {
      const existing = runtimeIdentityGuards.get(call) ?? [];
      guards.forEach((guard) => {
        if (
          !existing.some(
            (candidate) =>
              candidate.left.parameter === guard.left.parameter &&
              candidate.right.parameter === guard.right.parameter,
          )
        ) {
          existing.push(guard);
        }
      });
      runtimeIdentityGuards.set(call, existing);
    });
    diagnostics.push(
      ...checkTransientSameCallOverlaps({
        index,
        lookup: {
          localModuleId: moduleId,
          localCapabilities: capabilities,
          localContracts: resolvedContracts,
          importedCallables,
        },
        guardedPairs: transientGuardPlan.guardedPairs,
      }),
    );
  });
  const resolveContext: ResolveContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    contracts: resolvedContracts,
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
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.validateContracts",
    validationStartedAt,
  );
  if (checkBodies) {
    const selectionStartedAt = startCompilerPerfPhase();
    const checkedFunctions = flowFunctions;
    const checkedLambdas = flowLambdas;
    incrementCompilerPerfCounter(
      "borrowing.body.totalCallables",
      functions.length + lambdas.length,
    );
    incrementCompilerPerfCounter(
      "borrowing.body.checkedCallables",
      checkedFunctions.length + checkedLambdas.length,
    );
    const moduleStorageSymbols = new Set(
      Array.from(summaryHir.items.values())
        .filter((item) => item.kind === "module-let")
        .map((item) => item.symbol),
    );
    markCompilerPerfPhaseDuration(
      "analyzeBorrowing.selectBodies",
      selectionStartedAt,
    );
    const bodiesStartedAt = startCompilerPerfPhase();
    checkedFunctions.forEach((functionItem) =>
      callableFacts.get(functionItem.symbol)
        ? analyzeFunctionBorrowing({
            functionItem,
            facts: callableFacts.get(functionItem.symbol)!,
            lambdaFacts,
            lambdaContracts,
            hir: summaryHir,
            typing,
            symbolTable,
            moduleId,
            imports: importMap,
            dependencies,
            decls,
            contracts: resolvedContracts,
            moduleStorageSymbols,
            mutableStorageSymbols,
            runtimeIdentityGuards,
            diagnostics,
          })
        : undefined,
    );
    checkedLambdas.forEach((lambda) =>
      lambdaFacts.get(lambda.id)
        ?
        analyzeLambdaBodyBorrowing({
          lambda,
          facts: lambdaFacts.get(lambda.id)!,
          lambdaFacts,
          lambdaContracts,
          hir,
          typing,
          symbolTable,
          moduleId,
          imports: importMap,
          dependencies,
          decls,
          contracts: resolvedContracts,
          moduleStorageSymbols,
          mutableStorageSymbols,
          runtimeIdentityGuards,
          diagnostics,
        })
        : undefined,
    );
    markCompilerPerfPhaseDuration(
      "analyzeBorrowing.checkLoans",
      bodiesStartedAt,
    );
  }
  const queryDependencies = new Map(
    Array.from(inferred.queries, ([symbol, query]) => [
      symbol,
      new Map(
        query.dependencies.map((dependency) => [
          `${dependency.moduleId}:${dependency.symbol}`,
          dependency,
        ]),
      ),
    ]),
  );
  namedContracts.contracts.forEach((named, symbol) => {
    const dependenciesForCallable =
      queryDependencies.get(symbol) ?? new Map<string, SymbolRef>();
    const declaration = { moduleId, symbol: named.declaration };
    dependenciesForCallable.set(
      `${declaration.moduleId}:${declaration.symbol}`,
      declaration,
    );
    queryDependencies.set(symbol, dependenciesForCallable);
  });
  const queries = new Map(inferred.queries);
  const outputCallables = new Map(
    Array.from(callables, ([symbol, contract]) => [
      symbol,
      {
        ...contract,
        parameters: contract.parameters.map((parameter) => ({
          ...parameter,
          readPaths: parameter.readPaths ?? [],
          writePaths: parameter.writePaths ?? [],
        })),
      },
    ] as const),
  );
  outputCallables.forEach((output, symbol) => {
    const prior = inferred.queries.get(symbol);
    queries.set(symbol, {
      input:
        prior?.input ??
        `${moduleId}:${symbol}:declared:${JSON.stringify(output)}`,
      dependencies: Array.from(queryDependencies.get(symbol)?.values() ?? []),
      output,
    });
  });
  return {
    callables: outputCallables,
    capabilities,
    namedContracts: namedContracts.contracts,
    runtimeIdentityGuards,
    mutableStorageSymbols,
    diagnostics,
    analysisMetrics: {
      fullFactsMaterialized: lazyFacts.materializedCount(),
      fullFactSymbols: Array.from(allCallableFacts.keys()),
    },
    summaryDemand: inferred.demand,
    queries,
  };
};

const effectOperationCallableContracts = ({
  hir,
  typing,
  decls,
}: {
  hir: HirGraph;
  typing: TypingResult;
  decls: DeclTable;
}): ReadonlyMap<SymbolId, CallableBorrowContract> =>
  new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "effect"
        ? item.operations.flatMap((operation) => {
            const signature = typing.functions.getSignature(operation.symbol);
            if (!signature) {
              return [];
            }
            const resultContainsBorrow = typeContainsBorrowed(
              signature.returnType,
              typing,
            );
            const resultCarriesReference = typeCanCarryReference(
              signature.returnType,
              typing,
            );
            const resultReferencePaths = resultCarriesReference
              ? referenceOriginsInType(signature.returnType, typing).map(
                  (origin) => origin.path,
                )
              : [];
            const maySuspend =
              decls.getEffectOperation(operation.symbol)?.operation
                .resumable === "resume";
            const operationContract = {
              parameters: signature.parameters.map((parameter) => {
                const reference = typeCanCarryReference(parameter.type, typing);
                const access =
                  parameter.bindingKind === "mutable-ref"
                    ? ("mutable" as const)
                    : reference
                      ? ("shared" as const)
                      : ("owned" as const);
                return {
                  access,
                  ...(access === "shared" ? { readPaths: [[]] } : {}),
                  ...(access === "mutable" ? { writePaths: [[]] } : {}),
                  retained: reference,
                  returned: reference && resultCarriesReference,
                  ...(reference && resultCarriesReference
                    ? {
                        returnedOrigins: referenceOriginsInType(
                          parameter.type,
                          typing,
                        ).flatMap((source) =>
                          resultReferencePaths.map((result) => ({
                            source: source.path,
                            result,
                            endpointAccess: source.endpointAccess,
                          })),
                        ),
                      }
                    : {}),
                  ...(reference ? { externalRetainedPaths: [[]] } : {}),
                };
              }),
              maySuspend,
              borrowedResult: resultContainsBorrow
                ? ("external" as const)
                : ("none" as const),
              ...(resultReferencePaths.length > 0
                ? {
                    externalReturnedOrigins: referenceOriginsInType(
                      signature.returnType,
                      typing,
                    ).map((result) => ({
                      result: result.path,
                      endpointAccess: result.endpointAccess,
                    })),
                  }
                : {}),
            };
            return [[operation.symbol, operationContract] as const];
          })
        : [],
    ),
  );

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

const combineBorrowedResultPresence = (
  values: readonly BorrowedResultPresence[],
): BorrowedResultPresence =>
  values.includes("external")
    ? "external"
    : values.includes("parameter")
      ? "parameter"
      : "none";

/**
 * Module storage only needs the caller-visible presence encoded by compact
 * contracts. Function bodies were already analyzed by the shared fact/flow
 * solve; do not recursively reinterpret their HIR here.
 */
const moduleInitializerBorrowedPresence = ({
  exprId,
  path = [],
  hir,
  typing,
  resolveContext,
  seen = new Set(),
  borrowedContext = false,
}: {
  exprId: HirExprId;
  path?: readonly PlaceProjection[];
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
  seen?: ReadonlySet<HirExprId>;
  borrowedContext?: boolean;
}): BorrowedResultPresence => {
  if (seen.has(exprId)) {
    return "external";
  }
  const expression = hir.expressions.get(exprId);
  if (!expression) {
    return "external";
  }
  const type = typing.resolvedExprTypes.get(exprId);
  if (
    !borrowedContext &&
    typeof type === "number" &&
    projectedTypes(type, path, typing).every(
      (candidate) =>
        !typeContainsBorrowed(candidate, typing) &&
        !typing.arena.containsTypeParams(candidate),
    )
  ) {
    return "none";
  }
  const nextSeen = new Set(seen).add(exprId);
  const presence = (
    child: HirExprId,
    childPath: readonly PlaceProjection[] = [],
    childBorrowedContext = borrowedContext,
  ): BorrowedResultPresence =>
    moduleInitializerBorrowedPresence({
      exprId: child,
      path: childPath,
      hir,
      typing,
      resolveContext,
      seen: nextSeen,
      borrowedContext: childBorrowedContext,
    });
  if (path.length > 0) {
    const [projection, ...remaining] = path;
    if (expression.exprKind === "tuple" && projection?.kind === "tuple") {
      const element = expression.elements[projection.index];
      return typeof element === "number"
        ? presence(element, remaining)
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
        ? presence(
            provider.value,
            provider.kind === "spread" ? path : remaining,
          )
        : "none";
    }
    if (expression.exprKind === "field-access") {
      const selected = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return presence(expression.target, [selected, ...path]);
    }
  }
  switch (expression.exprKind) {
    case "literal":
    case "lambda":
      return borrowedContext ? "external" : "none";
    case "overload-set":
    case "continue":
      return "none";
    case "identifier":
      return "external";
    case "tuple": {
      const borrowedPaths =
        typeof type === "number" ? borrowedPathsInType(type, typing) : [];
      return combineBorrowedResultPresence(
        borrowedPaths.length > 0
          ? borrowedPaths.map((borrowedPath) =>
              moduleInitializerBorrowedPresence({
                exprId,
                path: borrowedPath,
                hir,
                typing,
                resolveContext,
                seen,
                borrowedContext: true,
              }),
            )
          : expression.elements.map((element) => presence(element)),
      );
    }
    case "object-literal": {
      if (expression.entries.length === 0) {
        return "none";
      }
      const borrowedPaths =
        typeof type === "number" ? borrowedPathsInType(type, typing) : [];
      return combineBorrowedResultPresence(
        borrowedPaths.length > 0
          ? borrowedPaths.map((borrowedPath) =>
              moduleInitializerBorrowedPresence({
                exprId,
                path: borrowedPath,
                hir,
                typing,
                resolveContext,
                seen,
                borrowedContext: true,
              }),
            )
          : expression.entries.map((entry) => presence(entry.value)),
      );
    }
    case "field-access": {
      const selected = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return presence(expression.target, [selected, ...path]);
    }
    case "block":
      return typeof expression.value === "number"
        ? presence(expression.value, path)
        : "none";
    case "if":
    case "cond":
      return combineBorrowedResultPresence([
        ...expression.branches.map((branch) => presence(branch.value, path)),
        ...(typeof expression.defaultBranch === "number"
          ? [presence(expression.defaultBranch, path)]
          : []),
      ]);
    case "match":
      return combineBorrowedResultPresence(
        expression.arms.map((arm) => presence(arm.value, path)),
      );
    case "effect-handler":
      return combineBorrowedResultPresence([
        presence(expression.body, path),
        ...expression.handlers.map((handler) => presence(handler.body, path)),
      ]);
    case "call":
    case "method-call": {
      const resolved = resolveBorrowCall(expression, resolveContext);
      const contract = resolved.contract;
      const resultPresence = contract?.borrowedResult ?? "external";
      if (resultPresence === "none") {
        const returnType = resolved.signature?.returnType;
        return !borrowedContext ||
          (typeof returnType === "number" &&
            (typeContainsBorrowed(returnType, typing) ||
              typing.arena.containsTypeParams(returnType)))
          ? "none"
          : "external";
      }
      const hasReturnedArgument =
        contract?.parameters.some(
          (parameter, parameterIndex) =>
            parameter.returned === true &&
            typeof resolved.arguments[parameterIndex] === "number",
        ) === true;
      if (resultPresence !== "parameter" && !hasReturnedArgument) {
        if (
          resultPresence === "external" &&
          contract?.externalReturnedOrigins !== undefined &&
          contract.externalReturnedOrigins.length > 0 &&
          contract.externalReturnedOrigins.every(
            (origin) => origin.fresh === true,
          )
        ) {
          return "none";
        }
        return resultPresence;
      }
      const inputs =
        contract?.parameters.flatMap((parameter, index) =>
          (parameter.returnedOrigins ?? []).flatMap((origin) => {
            const source = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: path,
            });
            return source ? [{ parameter: index, source }] : [];
          }),
        ) ?? [];
      if (inputs.length === 0) {
        return "external";
      }
      const argumentPresence = (
        parameter: number,
        source: readonly PlaceProjection[],
        active: ReadonlySet<number> = new Set(),
      ): BorrowedResultPresence => {
        if (active.has(parameter)) {
          return "external";
        }
        const argument = resolved.arguments[parameter];
        if (typeof argument === "number") {
          return presence(argument, source, true);
        }
        const parameterContract = contract?.parameters[parameter];
        if (
          parameterContract?.defaultBorrowedResult === "none" ||
          parameterContract?.defaultNoBorrowPaths?.some(
            (noBorrow) =>
              translateProjectionPath({
                result: noBorrow,
                source: [],
                requested: source,
              }) !== undefined,
          )
        ) {
          return "none";
        }
        const defaultInputs =
          parameterContract?.defaultOrigins?.flatMap((origin) => {
            const translated = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: source,
            });
            return translated
              ? [{ parameter: origin.parameter, source: translated }]
              : [];
          }) ?? [];
        return defaultInputs.length > 0
          ? combineBorrowedResultPresence(
              defaultInputs.map((input) =>
                argumentPresence(
                  input.parameter,
                  input.source,
                  new Set(active).add(parameter),
                ),
              ),
            )
          : "external";
      };
      return combineBorrowedResultPresence(
        inputs.map(({ parameter, source }) =>
          argumentPresence(parameter, source),
        ),
      );
    }
    case "assign":
      return presence(expression.value, path);
    case "break":
      return typeof expression.value === "number"
        ? presence(expression.value, path)
        : "none";
    case "loop":
    case "while":
      return "none";
  }
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
          moduleInitializerBorrowedPresence({
            exprId: item.initializer,
            hir,
            typing,
            resolveContext,
          }) === "none")
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
